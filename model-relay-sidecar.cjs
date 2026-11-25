// The host authorizes upstream model and package requests. The attached stdio channel keeps
// the sidecar on an internal Docker network.
const { timingSafeEqual } = require("node:crypto");
const { createServer } = require("node:http");

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 96 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_RESPONSE_QUEUE = 512 * 1024;
const MAX_TOTAL_RESPONSE_QUEUE = 2 * 1024 * 1024;
const MAX_HOST_QUEUE = 8 * 1024 * 1024;
const MAX_REQUEST_ID = 2_147_483_647;
const MAX_PACKAGE_REQUESTS = 8;
const decoder = new TextDecoder("utf-8", { fatal: true });

const token = process.env.RUNNER_MODEL_TOKEN;
const packages = process.env.RUNNER_PACKAGES_ENABLED === "1";
if (!token && !packages) {
	process.stderr.write("The container relay requires an enabled service.\n");
	process.exit(1);
}
const authorization = token ? Buffer.from(`Bearer ${token}`) : null;

const active = new Map();
const counts = { model: 0, package: 0 };
let requestId = 0;
let shuttingDown = false;

function reject(response, status) {
	response.writeHead(status, { "Connection": "close", "Cache-Control": "no-store" }).end();
}

function sendHost(message) {
	const line = JSON.stringify(message) + "\n";
	if (process.stdout.writableLength + Buffer.byteLength(line) > MAX_HOST_QUEUE) {
		shutdown(1);
		return;
	}
	process.stdout.write(line);
}

function cancel(request) {
	if (!active.delete(request.id)) return;
	counts[request.kind]--;
	if (request.sent && !request.ended && !shuttingDown) sendHost({ type: "cancel", id: request.id });
}

function authenticated(request) {
	const received = Buffer.from(request.headers.authorization ?? "");
	return received.length === authorization.length && timingSafeEqual(received, authorization);
}

const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
	const { method, url: path } = request;
	const model = authorization && method === "POST" && path === "/v1/responses";
	const packageRequest = packages && method === "GET" && path !== "/v1/responses" &&
		/^\/(?!\/)[!-~]{0,2047}$/.test(path) && !/[\\#]/.test(path);
	if (!model && !packageRequest) return reject(response, 404);
	if (model && !authenticated(request)) return reject(response, 401);
	if (shuttingDown) return reject(response, 503);
	if (requestId === MAX_REQUEST_ID) return reject(response, 503);
	const kind = model ? "model" : "package";
	if (counts[kind] >= (model ? 1 : MAX_PACKAGE_REQUESTS)) return reject(response, 429);
	if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) return reject(response, 413);
	if (packageRequest && (request.headers["transfer-encoding"] ||
		Number(request.headers["content-length"]) > 0)) return reject(response, 400);

	const state = { id: ++requestId, kind, response, sent: false, ended: false };
	active.set(state.id, state);
	counts[kind]++;
	response.once("close", () => cancel(state));
	response.once("finish", () => cancel(state));
	request.once("error", () => response.destroy());
	const frame = { type: "request", id: state.id, method, path };
	if (packageRequest) {
		request.resume();
		state.sent = true;
		sendHost(frame);
		return;
	}

	let size = 0;
	const parts = [];
	request.on("data", (part) => {
		if (!active.has(state.id) || state.ended) return;
		size += part.length;
		if (size > MAX_REQUEST_BYTES) {
			state.ended = true;
			reject(response, 413);
			return;
		}
		parts.push(part);
	});
	request.once("end", () => {
		if (!active.has(state.id) || state.ended) return;
		try {
			const body = decoder.decode(Buffer.concat(parts, size));
			state.sent = true;
			sendHost({ ...frame, body });
		} catch {
			state.ended = true;
			reject(response, 400);
		}
	});
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxConnections = 32;

function shutdown(code) {
	if (shuttingDown) return;
	shuttingDown = true;
	process.exitCode = code;
	for (const { response } of active.values()) {
		if (response.headersSent) response.destroy();
		else reject(response, 502);
	}
	active.clear();
	process.stdin.destroy();
	server.close();
	// Allow the HTTP error to drain. A failed stdio pipe or idle socket must not pin the relay.
	setTimeout(() => process.exit(code), 1000).unref();
}

function receive(line) {
	const message = JSON.parse(decoder.decode(line));
	if (!message || !Number.isSafeInteger(message.id) || message.id < 1 || message.id > MAX_REQUEST_ID ||
		!["headers", "chunk", "end", "abort"].includes(message.type)) {
		throw new Error("invalid host frame");
	}
	const request = active.get(message.id);
	if (!request) return; // The host can finish canceling an old request.
	const { response } = request;
	if (!request.sent || request.ended) throw new Error("invalid host response order");

	switch (message.type) {
		case "headers":
			if (response.headersSent || !Number.isInteger(message.status) ||
				message.status < 200 || message.status > 599 ||
				typeof message.contentType !== "string" || !/^[ -~]{1,256}$/.test(message.contentType)) {
				throw new Error("invalid host response headers");
			}
			response.writeHead(message.status, {
				"Content-Type": message.contentType,
				"Cache-Control": "no-store",
			});
			response.flushHeaders();
			break;
		case "chunk": {
			if (!response.headersSent || typeof message.data !== "string" ||
				message.data.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)) {
				throw new Error("invalid host response chunk");
			}
			const chunk = Buffer.from(message.data, "base64");
			if (chunk.length > MAX_CHUNK_BYTES || chunk.toString("base64") !== message.data) {
				throw new Error("invalid host response chunk");
			}
			let queued = chunk.length;
			for (const { response: pending } of active.values()) queued += pending.writableLength;
			if (response.writableLength + chunk.length > MAX_RESPONSE_QUEUE || queued > MAX_TOTAL_RESPONSE_QUEUE) {
				cancel(request);
				response.destroy();
			} else {
				response.write(chunk);
			}
			break;
		}
		case "end":
			if (!response.headersSent) throw new Error("host response ended before its headers");
			request.ended = true;
			response.end();
			break;
		case "abort":
			request.ended = true;
			if (response.headersSent) response.destroy();
			else reject(response, 502);
			break;
	}
}

let frameParts = [];
let frameSize = 0;
process.stdin.on("data", (buffer) => {
	try {
		let start = 0;
		while (!shuttingDown && start < buffer.length) {
			const newline = buffer.indexOf(10, start);
			const end = newline === -1 ? buffer.length : newline;
			const part = buffer.subarray(start, end);
			frameSize += part.length;
			if (frameSize > MAX_FRAME_BYTES) throw new Error("host frame is too large");
			frameParts.push(part);
			if (newline === -1) return;
			const line = Buffer.concat(frameParts, frameSize);
			frameParts = [];
			frameSize = 0;
			receive(line);
			start = newline + 1;
		}
	} catch {
		shutdown(1);
	}
});
process.stdin.once("end", () => shutdown(frameSize === 0 ? 0 : 1));
process.stdin.on("error", () => shutdown(1));
process.stdout.on("error", () => shutdown(1));
process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(0));
server.on("error", () => shutdown(1));
server.listen(8787, "0.0.0.0", () => sendHost({ type: "ready" }));
