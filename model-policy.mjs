// One run may stream responses from its configured model through the host. Only the host
// authorizes the upstream request and keeps the provider credential.
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_OUTPUT_TOKENS = 8192;

const requestFields = new Set([
	"model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
	"reasoning", "text", "include", "prompt_cache_key", "client_metadata", "service_tier",
	"store", "stream", "max_output_tokens",
]);
const inputTypes = new Set([
	"message", "reasoning", "additional_tools", "function_call", "function_call_output",
	"custom_tool_call", "custom_tool_call_output",
]);
const localToolTypes = new Set(["function", "custom"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function areLocalTools(tools) {
	if (!Array.isArray(tools)) return false;
	const pending = [...tools];
	while (pending.length) {
		const tool = pending.pop();
		if (!isRecord(tool) || typeof tool.name !== "string" || !tool.name) return false;
		if (localToolTypes.has(tool.type)) continue;
		if (tool.type !== "namespace" || !Array.isArray(tool.tools)) return false;
		for (const nested of tool.tools) pending.push(nested);
	}
	return true;
}

function isLocalToolChoice(choice) {
	if (choice === undefined || ["none", "auto", "required"].includes(choice)) return true;
	if (!isRecord(choice)) return false;
	if (choice.type === "allowed_tools") {
		return Array.isArray(choice.tools) && choice.tools.every(isNamedLocalTool);
	}
	return isNamedLocalTool(choice);
}

function isNamedLocalTool(tool) {
	return isRecord(tool) && localToolTypes.has(tool.type) && typeof tool.name === "string" && !!tool.name;
}

function isLocalInput(input) {
	if (typeof input === "string") return true;
	if (!Array.isArray(input)) return false;
	const pending = [];
	for (const item of input) {
		if (!isRecord(item) || !inputTypes.has(item.type ?? (item.role ? "message" : ""))) return false;
		if (item.type === "additional_tools") {
			if (!areLocalTools(item.tools)) return false;
		} else {
			pending.push(item);
		}
	}

	// Codex can send inline images and reasoning from the same run, but the provider may not
	// dereference a file, item or remote URL on the account's behalf.
	while (pending.length) {
		const item = pending.pop();
		if (Array.isArray(item)) {
			for (const nested of item) pending.push(nested);
			continue;
		}
		if (!isRecord(item)) continue;
		if (item.type === "item_reference" || item.file_id != null) return false;
		for (const url of [item.file_url, item.image_url]) {
			if (url != null && (typeof url !== "string" || !url.startsWith("data:"))) return false;
		}
		for (const nested of Object.values(item)) pending.push(nested);
	}
	return true;
}

function isAllowedRequest(body, model) {
	return isRecord(body) &&
		body.model === model &&
		Object.keys(body).every((key) => requestFields.has(key)) &&
		isLocalInput(body.input) &&
		(body.tools === undefined || areLocalTools(body.tools)) &&
		isLocalToolChoice(body.tool_choice) &&
		(body.include === undefined || (
			Array.isArray(body.include) && body.include.every((entry) => entry === "reasoning.encrypted_content")
		)) &&
		(body.service_tier == null || ["auto", "default"].includes(body.service_tier)) &&
		(body.max_output_tokens === undefined || (
			Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0
		));
}

function errorResponse(status, message) {
	return Response.json({ error: { message, type: "runner_model_relay_error" } }, { status });
}

function withoutProviderKey(body, apiKey) {
	const needle = Buffer.from(apiKey);
	let trailing = Buffer.alloc(0);
	return body.pipeThrough(new TransformStream({
		transform(chunk, controller) {
			const bytes = Buffer.concat([trailing, chunk]);
			if (bytes.includes(needle)) {
				controller.error(new Error("model provider returned a credential"));
				return;
			}
			// A credential can span two upstream chunks.
			const boundary = Math.max(0, bytes.length - needle.length + 1);
			if (boundary > 0) controller.enqueue(bytes.subarray(0, boundary));
			trailing = bytes.subarray(boundary);
		},
		flush(controller) {
			if (trailing.length > 0) controller.enqueue(trailing);
		},
	}));
}

export function createModelHandler({ model, apiKey, maxRequests, fetchImpl = fetch }) {
	if (typeof model !== "string" || !model.trim() || typeof apiKey !== "string" || !apiKey.trim()) {
		throw new TypeError("A model and host API key are required");
	}
	if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
		throw new TypeError("A positive request quota is required");
	}
	let remaining = maxRequests;

	return async (bodyText, { signal } = {}) => {
		if (typeof bodyText !== "string") return errorResponse(400, "Invalid model request.");
		if (Buffer.byteLength(bodyText) > MAX_REQUEST_BYTES) {
			return errorResponse(413, "Model request is too large.");
		}

		let body;
		try {
			body = JSON.parse(bodyText);
		} catch {
			return errorResponse(400, "Invalid model request.");
		}
		if (!isAllowedRequest(body, model)) return errorResponse(400, "Model request is not allowed.");
		if (!remaining) return errorResponse(429, "Model request quota exhausted.");
		// Reserve the slot before the first await. Errors and retries count against the same run.
		remaining--;

		try {
			const upstream = await fetchImpl(RESPONSES_URL, {
				method: "POST",
				headers: {
					"authorization": `Bearer ${apiKey}`,
					"content-type": "application/json",
					"accept": "text/event-stream",
				},
				body: JSON.stringify({
					...body,
					store: false,
					stream: true,
					max_output_tokens: Math.min(body.max_output_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
				}),
				redirect: "error",
				signal,
			});
			const contentType = upstream.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
			if (upstream.status !== 200 || contentType !== "text/event-stream" || !upstream.body) {
				void upstream.body?.cancel().catch(() => {});
				return errorResponse(502, "Model provider request failed.");
			}
			return new Response(withoutProviderKey(upstream.body, apiKey), {
				headers: { "content-type": "text/event-stream" },
			});
		} catch {
			return errorResponse(502, "Model provider request failed.");
		}
	};
}
