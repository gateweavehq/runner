import { createHash, randomUUID } from "node:crypto";
import { open, realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const REGISTRY = "https://registry.npmjs.org";
const RELAY = "http://model-relay:8787";
const MIB = 1024 * 1024;
const MAX_LOCK_BYTES = 8 * MIB;
export const MAX_TARBALL_BYTES = 64 * MIB;
const MAX_NETWORK_BYTES = 512 * MIB;
const MAX_NETWORK_REQUESTS = 2048;
const MAX_ACTIVE_DOWNLOADS = 16;

const npmName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?(?:\+[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function addPin(pins, name, version, integrity, resolved) {
	if (typeof name !== "string" || name.length > 214 || !npmName.test(name)
		|| typeof version !== "string" || version.length > 256 || !exactVersion.test(version)
		|| typeof integrity !== "string" || !/^sha512-[a-zA-Z0-9+/]{86}==$/.test(integrity)) {
		throw new Error("Package lock contains an unsupported name, version or integrity");
	}
	const digest = integrity.slice("sha512-".length);
	if (Buffer.from(digest, "base64").toString("base64") !== digest) {
		throw new Error("Package lock contains invalid SHA-512 integrity");
	}
	const basename = name.slice(name.lastIndexOf("/") + 1);
	const path = `/${name}/-/${basename}-${version}.tgz`;
	if (resolved !== undefined && resolved !== REGISTRY + path) {
		throw new Error("Package lock contains a noncanonical public npm tarball");
	}
	const previous = pins.get(path);
	if (previous && previous.integrity !== integrity) {
		throw new Error("Package lock contains conflicting integrity for the same package version");
	}
	pins.set(path, { name, version, integrity, digest });
}

function readNpmPins(lockText, pins) {
	let lock;
	try {
		lock = JSON.parse(lockText);
	} catch {
		throw new Error("Package access requires a valid npm lockfile");
	}
	if (!isRecord(lock) || ![2, 3].includes(lock.lockfileVersion) || !isRecord(lock.packages)) {
		throw new Error("Package access requires npm package-lock version 2 or 3");
	}
	for (const [installPath, pkg] of Object.entries(lock.packages)) {
		const marker = "/node_modules/";
		const name = ("/" + installPath).split(marker).at(-1);
		if (name === "/" + installPath) continue; // Root and workspace entries grant no registry access.
		if (!isRecord(pkg)) throw new Error("Package lock contains an unsupported npm package");
		if (pkg.link === true) continue;
		if ((pkg.name !== undefined && pkg.name !== name) || typeof pkg.resolved !== "string") {
			throw new Error("Package access does not support npm aliases or unresolved packages");
		}
		addPin(pins, name, pkg.version, pkg.integrity, pkg.resolved);
	}
}

async function readPnpmPins(lockText, pins) {
	const { parseAllDocuments } = await import("yaml").catch(() => {
		throw new Error("pnpm package access requires the runner's pinned yaml dependency");
	});
	let locks;
	try {
		const docs = parseAllDocuments(lockText, { strict: true, uniqueKeys: true });
		if (docs.some((doc) => doc.errors.length > 0 || doc.warnings.length > 0)) {
			throw new Error("Invalid YAML");
		}
		locks = docs.map((doc) => doc.toJS({ maxAliasCount: 0 }));
	} catch {
		throw new Error("Package access requires a valid pnpm lockfile without aliases");
	}
	if (locks.length === 0) throw new Error("Package access requires pnpm lockfile version 9");
	for (const lock of locks) {
		if (!isRecord(lock) || !["9.0", 9].includes(lock.lockfileVersion)) {
			throw new Error("Package access requires pnpm lockfile version 9");
		}
		if (lock.packages === undefined) continue;
		if (!isRecord(lock.packages)) throw new Error("Package lock contains an invalid packages section");
		for (const [key, pkg] of Object.entries(lock.packages)) {
			const separator = key.lastIndexOf("@");
			const resolution = pkg?.resolution;
			if (separator < 1 || !isRecord(resolution)
				|| Object.keys(resolution).some((value) => value !== "integrity" && value !== "tarball")) {
				throw new Error("Package lock contains an unsupported pnpm package");
			}
			addPin(pins, key.slice(0, separator), key.slice(separator + 1), resolution.integrity, resolution.tarball);
		}
	}
}

function buildMetadata(pins) {
	const versionsByName = new Map();
	for (const [path, { name, version, integrity }] of pins) {
		if (!versionsByName.has(name)) versionsByName.set(name, {});
		versionsByName.get(name)[version] = {
			name,
			version,
			dist: { integrity, tarball: RELAY + path },
		};
	}
	const routes = new Map();
	for (const [name, versions] of versionsByName) {
		const paths = [`/${name}`];
		if (name.startsWith("@")) {
			paths.push(`/${name.replace("/", "%2f")}`, `/${name.replace("/", "%2F")}`);
			paths.push(`/%40${name.slice(1).replace("/", "%2f")}`, `/%40${name.slice(1).replace("/", "%2F")}`);
		}
		// pnpm expects a default tag, even in frozen mode. Point it to a locked version.
		const packument = { name, "dist-tags": { latest: Object.keys(versions)[0] }, versions };
		for (const path of paths) {
			routes.set(path, packument);
			for (const [version, entry] of Object.entries(versions)) routes.set(`${path}/${version}`, entry);
		}
	}
	return routes;
}

async function verifyTarball(upstream, digest, accountBytes, storageDir, signal) {
	const declaredSize = Number(upstream.headers.get("content-length"));
	if (upstream.status !== 200 || !upstream.body || declaredSize > MAX_TARBALL_BYTES) {
		void upstream.body?.cancel().catch(() => {});
		return null;
	}
	const reader = upstream.body.getReader();
	const hash = createHash("sha512");
	const path = join(storageDir, `gateweave-package-${randomUUID()}.tgz`);
	let file;
	let size = 0;
	let done = false;
	let streaming = false;
	try {
		file = await open(path, "wx+", 0o600);
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				done = true;
				break;
			}
			size += next.value.byteLength;
			if (!accountBytes(next.value.byteLength) || size > MAX_TARBALL_BYTES) return null;
			signal?.throwIfAborted();
			hash.update(next.value);
			for (let offset = 0; offset < next.value.byteLength;) {
				const { bytesWritten } = await file.write(next.value, offset, next.value.byteLength - offset);
				if (bytesWritten === 0) throw new Error("Package spool write failed");
				offset += bytesWritten;
			}
		}
		if (hash.digest("base64") !== digest) return null;
		signal?.throwIfAborted();
		const stream = file.createReadStream({ start: 0, autoClose: true, signal });
		stream.once("close", () => { void unlink(path).catch(() => {}); });
		const response = new Response(Readable.toWeb(stream, { strategy: { highWaterMark: 1 } }), {
			headers: { "content-type": "application/octet-stream", "content-length": String(size) },
		});
		streaming = true;
		return response;
	} finally {
		if (!done) void reader.cancel().catch(() => {});
		reader.releaseLock();
		if (file && !streaming) {
			await file.close().catch(() => {});
			await unlink(path).catch(() => {});
		}
	}
}

const failure = (status, error) => Response.json({ error }, { status });

/** Bind the public npm routes and their integrity hashes to the committed lock for one run. */
export async function createPackageHandler({ kind, lockText, storageDir = tmpdir(), fetchImpl = fetch }) {
	if (typeof lockText !== "string" || Buffer.byteLength(lockText) > MAX_LOCK_BYTES) {
		throw new Error("Package lock is missing or exceeds the size limit");
	}
	const pins = new Map();
	if (kind === "npm") readNpmPins(lockText, pins);
	else if (kind === "pnpm") await readPnpmPins(lockText, pins);
	else throw new Error("Package access supports npm and pnpm lockfiles");
	const metadata = buildMetadata(pins);
	const spoolDir = await realpath(storageDir);
	let requests = 0;
	let networkBytes = 0;
	let active = 0;

	return async ({ method, path, signal }) => {
		if (method !== "GET") return failure(405, "Package relay only accepts GET");
		const packument = metadata.get(path);
		if (packument) return Response.json(packument);
		const pin = pins.get(path);
		if (!pin) return failure(404, "Package path is not locked");
		if (requests >= MAX_NETWORK_REQUESTS || networkBytes >= MAX_NETWORK_BYTES) {
			return failure(429, "Package download quota exhausted");
		}
		if (active >= MAX_ACTIVE_DOWNLOADS) return failure(429, "Too many active package downloads");
		requests++;
		active++;
		try {
			const upstream = await fetchImpl(REGISTRY + path, { method: "GET", redirect: "error", signal });
			const tarball = await verifyTarball(upstream, pin.digest, (size) => {
				networkBytes += size;
				return networkBytes <= MAX_NETWORK_BYTES;
			}, spoolDir, signal);
			return tarball ?? failure(502, "Unable to verify the locked package");
		} catch {
			return failure(502, "Unable to verify the locked package");
		} finally {
			active--;
		}
	};
}
