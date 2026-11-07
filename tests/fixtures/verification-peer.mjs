// Local JSONL RPC peer: no provider, keys, or network. Deliberately reuses IDs across attempts/runs.
import * as fs from "node:fs";
import * as readline from "node:readline";
const scenario = process.argv[2];
const file = process.argv[process.argv.indexOf("--session") + 1];
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const entries = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
	cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason,
	api: "fixture", provider: "fixture", model: "fixture", usage, timestamp: Date.now() });
function record(message, emit = true) {
	fs.appendFileSync(file, JSON.stringify({ type: "message", id: `${process.pid}-${entries().length}`, message }) + "\n");
	if (emit) send({ type: "message_end", message });
}
const start = (id, command, parent) => send({ type: "tool_execution_start", toolName: "bash", toolCallId: id,
	...(parent ? { parentToolCallId: parent } : {}), args: { command } });
const end = (id, text, parent, extra = {}) => send({ type: "tool_execution_end", toolName: "bash", toolCallId: id,
	...(parent ? { parentToolCallId: parent } : {}), result: { content: [{ type: "text", text }], ...extra }, isError: extra.isError ?? false });
const delta = (type, value = "token") => send({ type: "message_update", assistantMessageEvent: { type, delta: value } });
const settle = () => send({ type: "agent_settled", aborted: false });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
	const req = JSON.parse(line);
	const reply = (data) => send({ type: "response", id: req.id, command: req.type, success: true, data });
	if (req.type === "get_commands") return reply({ commands: [{ name: "subagents-ex-guard" }] });
	if (req.type === "get_session_stats") {
		if (scenario.startsWith("telemetry")) await new Promise((r) => setTimeout(r, 40));
		const messages = entries().map((entry) => entry.message).filter(Boolean);
		const sums = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((key) =>
			[key, messages.reduce((sum, message) => sum + (message.usage?.[key] ?? 0), 0)]));
		return reply({ tokens: sums, cost: messages.reduce((sum, message) => sum + (message.usage?.cost.total ?? 0), 0) });
	}
	if (req.type !== "prompt") return reply({});
	reply({});
	if (scenario === "telemetry-stream" || scenario === "telemetry-retry") {
		delta("text_start");
		delta("toolcall_delta");
		delta("text_delta", "");
		delta(file.endsWith("-1.jsonl") ? "thinking_delta" : "text_delta");
		delta("text_delta", "later");
	}
	if (scenario.startsWith("telemetry")) {
		const invalid = scenario === "telemetry-retry" && file.endsWith("-1.jsonl");
		record(assistant([{ type: "text", text: invalid ? "not-json" : '{"ok":true}' }]));
		settle();
		settle(); // Duplicated notifications must not multiply timing observations.
		return;
	}
	if (scenario.startsWith("accounting-")) {
		const sessionOnly = scenario === "accounting-session-crash";
		const charged = (content, cost, stopReason = "stop") => {
			const message = assistant(content, stopReason);
			message.usage = { ...usage, cost: { ...usage.cost, total: cost } };
			return message;
		};
		const publish = (message) => sessionOnly ? record(message, false) : send({ type: "message_end", message });
		publish(charged([{ type: "toolCall", id: "accounted-bash", name: "bash", arguments: { command: "large check" } }], 0.01, "toolUse"));
		const result = { role: "toolResult", toolCallId: "accounted-bash", toolName: "bash",
			content: [{ type: "text", text: "EARLY-SENTINEL\n" + "x".repeat(9 * 1024) }], details: { exitCode: 0 },
			...(sessionOnly ? {} : { usage: { ...usage, cost: { ...usage.cost, total: 0.02 } } }),
			isError: false, timestamp: Date.now() };
		if (scenario === "accounting-live-event") {
			start("accounted-bash", "large check");
			end("accounted-bash", result.content[0].text, undefined, { details: result.details });
		}
		publish(result);
		publish(charged([{ type: "text", text: "accounted after evidence failure" }], sessionOnly ? 0.02 : 0));
		if (sessionOnly) {
			send({ type: "entry_appended" });
			send({ type: "compaction_end" }); // Request another serialized recovery scan too.
			return process.exit(2);
		}
		settle();
		return;
	}
	const command = `printf '${req.message.includes("continuation") ? "new" : "old"} direct'`;
	record(assistant([{ type: "toolCall", id: "same", name: "bash", arguments: { command } },
		{ type: "toolCall", id: "wrap", name: "custom_wrapper", arguments: {} }], "toolUse"));
	start("same", command);
	start("wrap/1/1/1", "printf nested; exit 7", "wrap/1/1");
	if (scenario === "interrupted" || scenario === "cancel") {
		send({ type: "tool_execution_update", toolName: "bash", toolCallId: "wrap/1/1/1", parentToolCallId: "wrap/1/1",
			partialResult: { content: [{ type: "text", text: "partial nested output" }] } });
		if (scenario === "interrupted") return process.exit(2);
		process.on("SIGTERM", () => {});
		setInterval(() => {}, 1000);
		return;
	}
	const fallback = scenario === "fallback" || scenario === "fallback-crash";
	const result = { role: "toolResult", toolCallId: "same", toolName: "bash", content: [{ type: "text", text: "direct complete" }],
		...(fallback ? { details: { exitCode: 3 } } : {}), isError: fallback, timestamp: Date.now() };
	if (!fallback) {
		start("same", command); // Duplicate start/end and transcript observations.
		end("same", "direct complete");
		end("same", "direct complete");
	}
	record(result, !fallback);
	if (!fallback) send({ type: "message_end", message: result });
	if (!fallback) {
		end("wrap/1/1/1", "NESTED FAILURE " + "日本語".repeat(3000), "wrap/1/1", {
			structuredContent: { output: "NESTED FAILURE " + "日本語".repeat(3000), exit_code: 7, truncated: false }, isError: true,
		});
		start("unfinished", "never completed", "wrap");
	}
	if (scenario === "fallback-crash") return process.exit(2);
	record(assistant([{ type: "text", text: "fixture complete" }]));
	settle();
});
