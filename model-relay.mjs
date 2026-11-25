// The runner owns the upstream connections and exchanges bounded frames with the relay over
// Docker attach. The relay exposes HTTP to the engine on its isolated network.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModelHandler } from "./model-policy.mjs";
import { MAX_TARBALL_BYTES } from "./package-policy.mjs";

const relayImage = "node:24-bookworm-slim";
const relayUrl = "http://model-relay:8787";
const requestBytes = 1024 * 1024;
const frameBytes = 6 * requestBytes + 4096;
const chunkBytes = 32 * 1024;
const modelResponseBytes = 16 * 1024 * 1024;
const maxPackageRequests = 8;

function attach(docker, container, cwd, modelHandler, packageHandler) {
	const child = spawn(docker.argv[0], [
		...docker.argv.slice(1), "start", "--attach", "--interactive", "--", container,
	], { cwd, env: docker.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const ready = Promise.withResolvers();
	// Attach can fail before startup gets to the await below.
	ready.promise.catch(() => {});
	let started = false;
	let failure;
	const active = new Map();
	const pending = new Set();
	const counts = { model: 0, package: 0 };
	let input = "";

	function release(id, expected) {
		const state = active.get(id);
		if (!state || (expected && state !== expected)) return;
		active.delete(id);
		counts[state.kind]--;
		return state;
	}

	function stop(message) {
		if (failure) return;
		failure = new Error(message);
		for (const { controller } of active.values()) controller.abort();
		active.clear();
		ready.reject(failure);
		child.stdin.destroy();
		child.kill();
	}

	function send(frame) {
		return new Promise((resolve, reject) => {
			if (failure) {
				reject(failure);
				return;
			}
			child.stdin.write(JSON.stringify(frame) + "\n", (error) => error ? reject(error) : resolve());
		});
	}

	async function respond(frame, state) {
		const { id, body, method, path } = frame;
		const { kind, controller } = state;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
		const responseLimit = kind === "model" ? modelResponseBytes : MAX_TARBALL_BYTES;
		let responseBody;
		try {
			const response = kind === "model"
				? await modelHandler(body, { signal })
				: await packageHandler({ method, path, signal });
			responseBody = response.body;
			if (controller.signal.aborted) return;
			await send({
				type: "headers", id, status: response.status,
				contentType: response.headers.get("content-type") ?? "application/json",
			});
			if (controller.signal.aborted) return;
			let bytes = 0;
			if (responseBody) {
				for await (const chunk of responseBody) {
					bytes += chunk.length;
					if (bytes > responseLimit) throw new Error("response exceeded relay limit");
					for (let offset = 0; offset < chunk.length; offset += chunkBytes) {
						if (controller.signal.aborted) return;
						const part = chunk.subarray(offset, offset + chunkBytes);
						await send({ type: "chunk", id, data: Buffer.from(part).toString("base64") });
					}
				}
			}
			if (!controller.signal.aborted) {
				release(id, state);
				await send({ type: "end", id });
			}
		} catch {
			if (!controller.signal.aborted) {
				release(id, state);
				try {
					await send({ type: "abort", id });
				} catch {
					stop("could not write the container relay response");
				}
			}
		} finally {
			release(id, state);
			await responseBody?.cancel().catch(() => {});
		}
	}

	function receive(line) {
		if (Buffer.byteLength(line) > frameBytes) throw new Error("relay frame too large");
		const frame = JSON.parse(line);
		if (frame?.type === "ready" && !started) {
			started = true;
			ready.resolve();
			return;
		}
		if (!started || !Number.isSafeInteger(frame?.id) || frame.id <= 0 || frame.id > 2_147_483_647) {
			throw new Error("invalid relay frame");
		}
		if (frame.type === "cancel") {
			release(frame.id)?.controller.abort();
			return;
		}
		const model = modelHandler && frame.method === "POST" && frame.path === "/v1/responses" &&
			typeof frame.body === "string" && Buffer.byteLength(frame.body) <= requestBytes;
		const packageRequest = packageHandler && frame.method === "GET" && frame.body === undefined &&
			typeof frame.path === "string" && frame.path !== "/v1/responses" &&
			/^\/(?!\/)[!-~]{0,2047}$/.test(frame.path) && !/[\\#]/.test(frame.path);
		const kind = model ? "model" : "package";
		if (frame.type !== "request" || active.has(frame.id) || (!model && !packageRequest) ||
			counts[kind] >= (model ? 1 : maxPackageRequests)) {
			throw new Error("invalid relay request");
		}
		const state = { kind, controller: new AbortController() };
		active.set(frame.id, state);
		counts[kind]++;
		const task = respond(frame, state);
		pending.add(task);
		void task.then(() => pending.delete(task), () => pending.delete(task));
	}

	child.stdin.on("error", () => stop("container relay input closed"));
	child.on("error", () => stop("could not attach container relay"));
	child.on("close", () => stop("container relay disconnected"));
	child.stderr.resume();
	child.stdout.setEncoding("utf8").on("data", (chunk) => {
		if (failure) return;
		input += chunk;
		try {
			let newline;
			while ((newline = input.indexOf("\n")) >= 0) {
				receive(input.slice(0, newline));
				input = input.slice(newline + 1);
			}
			if (Buffer.byteLength(input) > frameBytes) throw new Error("relay frame too large");
		} catch {
			stop("container relay sent an invalid frame");
		}
	});
	const startupTimer = setTimeout(() => stop("container relay did not become ready"), 10_000);
	return {
		ready: ready.promise.finally(() => clearTimeout(startupTimer)),
		check() {
			if (failure) throw failure;
		},
		async close() {
			stop("container relay closed");
			// Canceled IDs can still be closing a verified package spool.
			if (!pending.size) return;
			let timer;
			try {
				await Promise.race([
					Promise.allSettled(pending),
					new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
				]);
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

export async function startContainerRelay({ docker, cwd, root, name, user, model, packageHandler, packageKind, log }) {
	if (!model && typeof packageHandler !== "function") throw new Error("container relay requires an enabled service");
	const network = name + "-network";
	const container = name + "-relay";
	const token = model ? randomBytes(32).toString("hex") : "";
	const redact = (value) => token ? value.replaceAll(token, "[redacted]") : value;
	const modelEnv = token ? ["--env", `RUNNER_MODEL_TOKEN=${token}`] : [];
	const packageEnv = packageHandler ? ["--env", "RUNNER_PACKAGES_ENABLED=1"] : [];
	const packageConcurrency = packageKind === "npm"
		? "npm_config_maxsockets"
		: packageKind === "pnpm" ? "npm_config_network_concurrency" : undefined;
	let attached;
	let networkPending = false;
	let containerPending = false;

	async function close() {
		await attached?.close();
		if (containerPending) {
			try {
				await docker.call(["rm", "-f", "-v", "--", container]);
			} catch (error) {
				if (!String(error.stderr ?? "").includes("No such container")) {
					log(`could not remove Docker container relay ${container}`);
				}
			}
		}
		if (networkPending) {
			try {
				await docker.call(["network", "rm", "--", network]);
			} catch (error) {
				if (!String(error.stderr ?? "").includes("not found")) {
					log(`could not remove Docker relay network ${network}`);
				}
			}
		}
	}

	try {
		const modelHandler = model && createModelHandler({
			model: model.name, apiKey: model.apiKey, maxRequests: model.maxRequests, fetchImpl: model.fetchImpl,
		});
		const { stdout } = await docker.call([
			"image", "inspect", "--format", '{{.Id}} {{if index .Config "Volumes"}}volumes{{else}}no-volumes{{end}}',
			"--", relayImage,
		]);
		const [imageId, volumeMode] = stdout.trim().split(" ");
		if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || volumeMode !== "no-volumes") {
			throw new Error("container relay requires a local Node image without declared volumes");
		}
		const source = join(root, "relay");
		await mkdir(source);
		await copyFile(new URL("./model-relay-sidecar.cjs", import.meta.url), join(source, "relay.cjs"));
		const mount = `type=bind,"source=${source.replaceAll('"', '""')}",target=/relay,readonly`;
		networkPending = true;
		await docker.call([
			"network", "create", "--internal", "--ipv6=false", "--opt",
			"com.docker.network.bridge.gateway_mode_ipv4=isolated", "--", network,
		]);
		containerPending = true;
		await docker.call([
			"create", "--name", container, "--pull", "never", "--interactive",
			"--network", network, "--network-alias", "model-relay", "--read-only", "--log-driver", "none",
			"--no-healthcheck", "--ipc", "none", "--user", user, "--cap-drop", "ALL",
			"--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m",
			"--mount", mount, ...modelEnv, ...packageEnv, "--entrypoint", "node",
			"--", imageId, "/relay/relay.cjs",
		]);
		attached = attach(docker, container, cwd, modelHandler, packageHandler);
		await attached.ready;
		return {
			network,
			engineArgs: [
				...modelEnv,
				...(model ? ["--env", `RUNNER_MODEL_BASE_URL=${relayUrl}/v1`] : []),
				...(packageHandler ? [
					"--env", `RUNNER_PACKAGE_REGISTRY=${relayUrl}`, "--env", `npm_config_registry=${relayUrl}`,
					...(packageConcurrency ? ["--env", `${packageConcurrency}=${maxPackageRequests}`] : []),
				] : []),
			],
			check: () => attached.check(),
			redact,
			close,
		};
	} catch (error) {
		await close();
		const reason = redact(String(error.stderr || error.message));
		throw new Error(`could not start container relay: ${reason.trim()}`);
	}
}
