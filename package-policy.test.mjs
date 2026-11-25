import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createPackageHandler, MAX_TARBALL_BYTES } from "./package-policy.mjs";

const registry = "https://registry.npmjs.org";
const relay = "http://model-relay:8787";
const tarPath = "/fixture/-/fixture-1.2.3.tgz";
const tarball = Buffer.from("fixture package archive bytes");
const sha512 = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const integrity = sha512(tarball);
const entry = { version: "1.2.3", resolved: registry + tarPath, integrity };
const npmLock = (extras = {}, version = 3) => JSON.stringify({
	lockfileVersion: version,
	packages: { "": { name: "workspace" }, "node_modules/fixture": entry, ...extras },
});
const get = (path, signal) => ({ method: "GET", path, signal });

test("serves only locked npm metadata and integrity-checked tarballs with fixed outbound routing", async () => {
	for (const version of [2, 3]) {
		const calls = [];
		const handle = await createPackageHandler({
			kind: "npm",
			lockText: npmLock({
				"packages/workspace": { version: "1.0.0" },
				"node_modules/workspace": { link: true, resolved: "packages/workspace" },
			}, version),
			async fetchImpl(url, options) {
				calls.push({ url, options });
				return new Response(tarball, { headers: { "x-upstream-private": "not forwarded" } });
			},
		});
		const pinned = { name: "fixture", version: "1.2.3", dist: { integrity, tarball: relay + tarPath } };
		assert.deepEqual(await (await handle(get("/fixture"))).json(), {
			name: "fixture", "dist-tags": { latest: "1.2.3" }, versions: { "1.2.3": pinned },
		});
		assert.deepEqual(await (await handle(get("/fixture/1.2.3"))).json(), pinned);
		assert.equal((await handle(get("/fixture/1.2.4"))).status, 404);
		assert.equal((await handle(get("/workspace"))).status, 404);
		assert.equal((await handle(get(tarPath + "?source=other"))).status, 404);
		assert.equal((await handle(get("https://fixture.example" + tarPath))).status, 404);
		assert.equal((await handle({ method: "HEAD", path: tarPath })).status, 405);
		assert.equal(calls.length, 0);

		const signal = new AbortController().signal;
		const response = await handle(get(tarPath, signal));
		assert.equal(response.status, 200);
		assert.deepEqual([...response.headers], [
			["content-length", String(tarball.length)], ["content-type", "application/octet-stream"],
		]);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), tarball);
		assert.deepEqual(calls, [{
			url: registry + tarPath, options: { method: "GET", redirect: "error", signal },
		}]);
	}
});

test("derives both pnpm v9 documents and synthesizes scoped registry metadata", async () => {
	const lockText = `---
lockfileVersion: "9.0"
packages:
  "@pnpm/exe.linux-x64@12.4.2":
    resolution: { integrity: ${integrity} }
---
lockfileVersion: '9.0'
packages:
  '@scope/fixture@1.2.3':
    resolution: { integrity: ${integrity} }
  '@scope/fixture@1.2.4':
    resolution: { integrity: ${integrity} }
snapshots:
  '@scope/fixture@1.2.3(peer@9.9.9)': {}
importers:
  .:
    dependencies:
      peer:
        specifier: link:./packages/local
        version: link:./packages/local
`;
	const handle = await createPackageHandler({
		kind: "pnpm", lockText,
		async fetchImpl(url) {
			assert.equal(url, registry + "/@scope/fixture/-/fixture-1.2.4.tgz");
			return new Response(tarball);
		},
	});
	assert.equal((await handle(get("/@pnpm%2fexe.linux-x64/12.4.2"))).status, 200);
	const metadata = await (await handle(get("/@scope%2Ffixture"))).json();
	assert.equal(metadata.name, "@scope/fixture");
	assert.deepEqual(Object.keys(metadata.versions), ["1.2.3", "1.2.4"]);
	assert.deepEqual(metadata.versions["1.2.4"].dist, {
		integrity, tarball: relay + "/@scope/fixture/-/fixture-1.2.4.tgz",
	});
	assert.equal("time" in metadata, false);
	assert.equal(metadata["dist-tags"].latest, "1.2.3");
	assert.equal((await handle(get("/peer"))).status, 404);
	const response = await handle(get("/@scope/fixture/-/fixture-1.2.4.tgz"));
	assert.equal(response.status, 200);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), tarball);
});

test("rejects external tarballs, unsupported source kinds, conflicting pins and invalid YAML", async () => {
	for (const resolved of [
		"file:fixture.tgz", "git+https://fixture.example/source", "http://registry.npmjs.org" + tarPath,
		"https://packages.fixture.example" + tarPath, registry + tarPath + "?different=true",
	]) {
		await assert.rejects(
			createPackageHandler({ kind: "npm", lockText: npmLock({ "node_modules/fixture": { ...entry, resolved } }) }),
			/noncanonical public npm tarball/,
		);
	}
	await assert.rejects(createPackageHandler({
		kind: "npm", lockText: npmLock({ "node_modules/alias": { ...entry, name: "fixture" } }),
	}), /npm aliases/);
	await assert.rejects(createPackageHandler({
		kind: "npm", lockText: npmLock({
			"node_modules/some-parent/node_modules/fixture": { ...entry, integrity: sha512("other bytes") },
		}),
	}), /conflicting integrity/);
	await assert.rejects(createPackageHandler({
		kind: "npm", lockText: npmLock({ "node_modules/fixture": { ...entry, integrity: "sha1-short" } }),
	}), /unsupported name, version or integrity/);
	await assert.rejects(createPackageHandler({
		kind: "pnpm", lockText: `lockfileVersion: "9.0"
packages: &pins
  fixture@1.2.3: { resolution: { integrity: ${integrity} } }
snapshots: *pins
`,
	}), /without aliases/);
	await assert.rejects(createPackageHandler({
		kind: "pnpm", lockText: `lockfileVersion: "9.0"
packages:
  fixture@1.2.3: { resolution: { integrity: ${integrity} } }
  fixture@1.2.3: { resolution: { integrity: ${integrity} } }
`,
	}), /valid pnpm lockfile/);
	await assert.rejects(createPackageHandler({
		kind: "pnpm", lockText: `lockfileVersion: "9.0"
packages:
  fixture@1.2.3: { resolution: { integrity: ${integrity}, tarball: "https://fixture.example/package.tgz" } }
`,
	}), /noncanonical public npm tarball/);
});

test("withholds bytes for mismatched, oversized and failed downloads", async () => {
	const chunk = new Uint8Array(1024 * 1024);
	let canceled = false;
	const cases = [
		() => new Response("different bytes"),
		() => Response.redirect("https://fixture.example/package.tgz"),
		() => new Response("internal provider detail", { status: 500 }),
		() => new Response(tarball, { headers: { "content-length": String(MAX_TARBALL_BYTES + 1) } }),
		() => new Response(new ReadableStream({
			pull(stream) {
				stream.enqueue(chunk);
			},
			cancel() { canceled = true; },
		})),
		() => { throw new Error("internal provider detail"); },
	];
	for (const fetchImpl of cases) {
		const handle = await createPackageHandler({ kind: "npm", lockText: npmLock(), fetchImpl });
		const response = await handle(get(tarPath));
		assert.equal(response.status, 502);
		assert.deepEqual(await response.json(), { error: "Unable to verify the locked package" });
	}
	assert.equal(canceled, true);
});

test("spools large verified tarballs and cleans the file after streaming, cancellation and errors", async (t) => {
	const storageDir = await mkdtemp(join(tmpdir(), "runner-package-spool-test-"));
	t.after(() => rm(storageDir, { recursive: true, force: true }));
	const chunk = new Uint8Array(1024 * 1024).fill(65);
	const count = 17;
	const hash = createHash("sha512");
	for (let i = 0; i < count; i++) hash.update(chunk);
	const lockText = npmLock({
		"node_modules/fixture": { ...entry, integrity: `sha512-${hash.digest("base64")}` },
	});
	let corrupt = false;
	const handle = await createPackageHandler({
		kind: "npm",
		lockText,
		storageDir,
		async fetchImpl() {
			if (corrupt) return new Response("wrong tarball");
			let sent = 0;
			return new Response(new ReadableStream({
				pull(controller) {
					if (sent === count) controller.close();
					else {
						controller.enqueue(chunk);
						sent++;
					}
				},
			}));
		},
	});
	async function waitForEmpty() {
		for (let i = 0; i < 100; i++) {
			if ((await readdir(storageDir)).length === 0) return;
			await sleep(10);
		}
		assert.deepEqual(await readdir(storageDir), []);
	}

	const complete = await handle(get(tarPath));
	assert.equal(complete.status, 200);
	const [spooled] = await readdir(storageDir);
	assert.ok(spooled);
	assert.equal((await stat(join(storageDir, spooled))).size, count * chunk.length);
	let read = 0;
	for await (const bytes of complete.body) read += bytes.length;
	assert.equal(read, count * chunk.length);
	await waitForEmpty();

	const canceled = (await handle(get(tarPath))).body;
	const reader = canceled.getReader();
	assert.ok((await reader.read()).value.length < chunk.length);
	await reader.cancel();
	await waitForEmpty();

	const controller = new AbortController();
	const aborted = await handle(get(tarPath, controller.signal));
	controller.abort();
	await assert.rejects(aborted.arrayBuffer());
	await waitForEmpty();

	corrupt = true;
	assert.equal((await handle(get(tarPath))).status, 502);
	assert.deepEqual(await readdir(storageDir), []);
});

test("bounds parallel and total outbound requests, including failures", async () => {
	const blocked = [];
	const handle = await createPackageHandler({
		kind: "npm", lockText: npmLock(),
		fetchImpl() {
			if (blocked.length < 16) return new Promise((resolve) => blocked.push(resolve));
			throw new Error("upstream unavailable");
		},
	});
	const pending = Array.from({ length: 16 }, () => handle(get(tarPath)));
	assert.equal((await handle(get(tarPath))).status, 429);
	for (const resolve of blocked) resolve(new Response(tarball));
	for (const response of await Promise.all(pending)) {
		assert.equal(response.status, 200);
		await response.arrayBuffer();
	}
	for (let i = 16; i < 2048; i++) assert.equal((await handle(get(tarPath))).status, 502);
	assert.equal((await handle(get(tarPath))).status, 429);
});
