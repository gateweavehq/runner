import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelHandler } from "./model-policy.mjs";

const model = "gpt-6.2-sol";
const apiKey = "test-provider-key";
const responseEvent = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
const request = (fields = {}) => JSON.stringify({ model, input: "Probe", ...fields });
const upstreamStream = () => new Response(responseEvent, {
	headers: { "content-type": "text/event-stream; charset=utf-8", "x-provider-debug": apiKey },
});

test("forwards the Codex Responses shape with fixed transport, host auth and hard limits", async () => {
	const calls = [];
	const signal = new AbortController().signal;
	const handle = createModelHandler({
		model,
		apiKey,
		maxRequests: 1,
		async fetchImpl(url, options) {
			calls.push({ url, options });
			return upstreamStream();
		},
	});
	const localTools = [
		{ type: "function", name: "shell_command", parameters: { type: "object" } },
		{ type: "custom", name: "apply_patch", format: { type: "text" } },
	];
	const cliInput = [
		{
			type: "additional_tools",
			id: "tools_example",
			role: "developer",
			tools: [{ type: "namespace", name: "local", tools: localTools }],
		},
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Probe" }] },
		{ type: "reasoning", id: "rs_example", summary: [], encrypted_content: "state" },
		{ type: "function_call", name: "shell_command", call_id: "call_1", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_1", output: "Done" },
		{ type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "local patch" },
		{ type: "custom_tool_call_output", call_id: "call_2", output: "Done" },
	];
	const body = {
		model,
		input: cliInput,
		tools: localTools,
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning: { effort: "medium" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: "run-example",
		client_metadata: { session_id: "fixture" },
		text: { verbosity: "low" },
		store: true,
		stream: false,
		max_output_tokens: 90_000,
	};
	const response = await handle(JSON.stringify(body), { signal });
	assert.equal(response.status, 200);
	assert.deepEqual([...response.headers], [["content-type", "text/event-stream"]]);
	assert.equal(await response.text(), responseEvent);
	assert.equal(calls.length, 1);
	const [{ url, options }] = calls;
	assert.equal(url, "https://api.openai.com/v1/responses");
	assert.equal(options.method, "POST");
	assert.equal(options.redirect, "error");
	assert.equal(options.signal, signal);
	assert.deepEqual(new Headers(options.headers).get("authorization"), `Bearer ${apiKey}`);
	assert.deepEqual(JSON.parse(options.body), { ...body, store: false, stream: true, max_output_tokens: 8192 });
});

test("rejects hosted tools, remote or stored input, other models and routes before fetching", async () => {
	let fetches = 0;
	const handle = createModelHandler({
		model, apiKey, maxRequests: 1,
		async fetchImpl() { fetches++; return upstreamStream(); },
	});
	for (const fields of [
		{ model: "other-model" },
		{ url: "https://fixture.example/v1/responses" },
		{ authorization: "client-authorization" },
		{ previous_response_id: "resp_example" },
		{ conversation: "conv_example" },
		{ prompt: { id: "pmpt_example" } },
		{ tools: [{ type: "web_search" }] },
		{ tools: [{ type: "namespace", name: "nested", tools: [{ type: "mcp", name: "remote" }] }] },
		{ input: [{ type: "additional_tools", tools: [{ type: "code_interpreter" }] }] },
		{ input: [{ type: "item_reference", id: "msg_example" }] },
		{ input: [{ id: "msg_example" }] },
		{ input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_example" }] }] },
		{ input: [{ type: "message", role: "user", content: [{
			type: "input_image", image_url: "https://fixture.example/image.png",
		}] }] },
		{ service_tier: "priority" },
		{ tool_choice: { type: "web_search" } },
	]) {
		assert.equal((await handle(request(fields))).status, 400, JSON.stringify(fields));
	}
	assert.equal((await handle("{broken JSON")).status, 400);
	assert.equal((await handle(request({ input: "é".repeat(600_000) }))).status, 413);
	assert.equal(fetches, 0);
	assert.equal((await handle(request())).status, 200);
	assert.equal(fetches, 1);
});

test("sanitizes provider failures, unexpected content and aborted fetches", async () => {
	const cases = [
		() => { throw new Error(apiKey); },
		() => new Response(apiKey, { status: 401, headers: { "x-debug": apiKey } }),
		() => new Response(apiKey, { headers: { "content-type": "application/json" } }),
	];
	for (const fetchImpl of cases) {
		const handle = createModelHandler({ model, apiKey, maxRequests: 1, fetchImpl });
		const response = await handle(request());
		assert.equal(response.status, 502);
		assert.equal(response.headers.has("x-debug"), false);
		assert.deepEqual(await response.json(), {
			error: { message: "Model provider request failed.", type: "runner_model_relay_error" },
		});
		assert.equal((await handle(request())).status, 429);
	}

	const controller = new AbortController();
	const handle = createModelHandler({
		model, apiKey, maxRequests: 1,
		fetchImpl(_url, { signal }) {
			assert.equal(signal, controller.signal);
			return new Promise((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		},
	});
	const pending = handle(request(), { signal: controller.signal });
	controller.abort(new Error(apiKey));
	const response = await pending;
	assert.equal(response.status, 502);
	assert.doesNotMatch(await response.text(), /test-provider-key/);
});

test("reserves quota before fetching so concurrent requests cannot reuse the slot", async () => {
	let resolveProvider;
	let fetches = 0;
	const handle = createModelHandler({
		model, apiKey, maxRequests: 1,
		fetchImpl() {
			fetches++;
			return new Promise((resolve) => { resolveProvider = resolve; });
		},
	});
	const first = handle(request());
	const next = await Promise.all([handle(request()), handle(request())]);
	assert.deepEqual(next.map((response) => response.status), [429, 429]);
	assert.equal(fetches, 1);
	resolveProvider(upstreamStream());
	assert.equal((await first).status, 200);
});

test("terminates the upstream stream if it returns the host key across chunks", async () => {
	const handle = createModelHandler({
		model, apiKey, maxRequests: 1,
		async fetchImpl() {
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(Buffer.from("data: " + apiKey.slice(0, 5)));
					controller.enqueue(Buffer.from(apiKey.slice(5) + "\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const response = await handle(request());
	await assert.rejects(response.text(), /model provider returned a credential/);
});
