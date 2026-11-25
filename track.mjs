// A minimal MCP Streamable HTTP client, enough for Track's /mcp: initialize, then tools/call.
// No dependencies. Node 24. Responses may be plain JSON or server-sent events; both are read.

export class TrackError extends Error {
	constructor(message, { status, code } = {}) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

const FALLBACK_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

/** The JSON-RPC messages carried by the `data:` lines of an SSE body. */
export function parseSse(text) {
	const messages = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			messages.push(JSON.parse(data));
		} catch {
			// A keepalive or a line split across reads; the next data line carries the message.
		}
	}
	return messages;
}

/** What a tools/call result carries, as the caller wants it: structured content, else parsed text. */
export function toolResult(result) {
	if (result?.isError) {
		const text = (result.content ?? []).map((c) => c?.text ?? "").join("\n");
		throw new TrackError(`Track tool failed: ${text || "no detail"}`);
	}
	if (result?.structuredContent !== undefined) return result.structuredContent;
	const text = (result?.content ?? []).find((c) => c?.type === "text")?.text;
	if (typeof text === "string") {
		try {
			return JSON.parse(text);
		} catch {
			return { text };
		}
	}
	return result ?? {};
}

export class TrackMcp {
	#url;
	#key;
	#fetch;
	#timeoutMs;
	#sessionId = null;
	#protocolVersion = null;
	#nextId = 1;
	#ready = null;

	constructor({ url, key, fetchImpl, timeoutMs = 30_000 }) {
		if (!url || !key) throw new TrackError("TrackMcp needs a url and a key");
		this.#url = url.replace(/\/+$/, "");
		this.#key = key;
		this.#fetch = fetchImpl ?? fetch;
		this.#timeoutMs = timeoutMs;
	}

	/** Connects once; a failed handshake is forgotten so the next call tries again. */
	connect() {
		this.#ready ??= this.#handshake().catch((error) => {
			this.#ready = null;
			this.#sessionId = null;
			this.#protocolVersion = null;
			throw error;
		});
		return this.#ready;
	}

	async #handshake() {
		this.#sessionId = null;
		this.#protocolVersion = null;
		let lastError;
		for (const version of FALLBACK_PROTOCOL_VERSIONS) {
			try {
				const result = await this.#request(
					"initialize",
					{
						protocolVersion: version,
						capabilities: {},
						clientInfo: { name: "gateweave-local-runner", version: "0.1.0" },
					},
					{ retries: 1 },
				);
				this.#protocolVersion = result?.protocolVersion ?? version;
				break;
			} catch (error) {
				lastError = error;
				if (error instanceof TrackError && error.code === -32600) continue; // unsupported version
				throw error;
			}
		}
		if (!this.#protocolVersion) throw lastError;
		await this.#post(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ notification: true },
		);
	}

	/** Calls one of Track's MCP tools and returns its structured result. */
	async call(name, args = {}) {
		await this.connect();
		const result = await this.#request("tools/call", { name, arguments: args });
		return toolResult(result);
	}

	/** The scoped runner API only gives its handle to the launcher, outside the MCP session. */
	async workRun(action, body) {
		if (!["find", "claim", "report"].includes(action)) throw new TrackError("Unknown work run action");
		let response;
		try {
			response = await this.#fetch(`${this.#url}/api/work-runs/${action}`, {
				method: "POST",
				headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch {
			throw new TrackError("Track did not answer the work run request");
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new TrackError(`Track refused the work run request (HTTP ${response.status})`, {
				status: response.status,
			});
		}
		try {
			return await response.json();
		} catch {
			throw new TrackError("Track returned an invalid work run response");
		}
	}

	async #request(method, params, { retries = 3 } = {}) {
		const id = this.#nextId++;
		let lastError;
		for (let attempt = 0; attempt < retries; attempt++) {
			try {
				return await this.#post({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				lastError = error;
				// A refused key or a bad request will not heal by asking again.
				if (error instanceof TrackError && (error.status === 401 || error.status === 403)) throw error;
				if (error instanceof TrackError && error.code !== undefined && error.code !== -32000) throw error;
				if (attempt + 1 < retries) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
			}
		}
		throw lastError;
	}

	async #post(message, { notification = false } = {}) {
		const headers = {
			authorization: `Bearer ${this.#key}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
		if (!notification && this.#protocolVersion) {
			headers["mcp-protocol-version"] = this.#protocolVersion;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		let response;
		try {
			response = await this.#fetch(`${this.#url}/mcp`, {
				method: "POST",
				headers,
				body: JSON.stringify(message),
				signal: controller.signal,
			});
		} catch (error) {
			throw new TrackError(`Track did not answer: ${error.message}`);
		} finally {
			clearTimeout(timer);
		}
		const session = response.headers.get("mcp-session-id");
		if (session) this.#sessionId = session;
		if (response.status === 401 || response.status === 403) {
			throw new TrackError(`Track refused the agent key (HTTP ${response.status})`, {
				status: response.status,
			});
		}
		if (notification) {
			if (!response.ok && response.status !== 202) {
				throw new TrackError(`Track answered HTTP ${response.status}`, { status: response.status });
			}
			return null;
		}
		if (!response.ok) {
			throw new TrackError(`Track answered HTTP ${response.status}`, { status: response.status });
		}
		const type = response.headers.get("content-type") ?? "";
		const text = await response.text();
		const messages = type.includes("text/event-stream") ? parseSse(text) : safeJson(text);
		const reply = messages.find((m) => m && m.id === message.id);
		if (!reply) throw new TrackError("Track's answer carried no reply to the request");
		if (reply.error) {
			throw new TrackError(`Track error ${reply.error.code}: ${reply.error.message}`, {
				code: reply.error.code,
			});
		}
		return reply.result;
	}
}

function safeJson(text) {
	try {
		return [JSON.parse(text)];
	} catch {
		return [];
	}
}
