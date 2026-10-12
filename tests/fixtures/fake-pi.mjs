// Deterministic RPC peer for transport, retry, persistence and cancellation tests.
import { createInterface } from "node:readline";
import * as fs from "node:fs";
const scenario = process.argv[2];
const sessionFile = process.argv[process.argv.indexOf("--session") + 1];
const messages = fs.existsSync(sessionFile)
	? fs
			.readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((s) => JSON.parse(s))
	: [];
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const response = (req, data) => send({ type: "response", id: req.id, command: req.type, success: true, data });
const usage = (n) => ({
	input: n * 10,
	output: n * 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: n * 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: n / 10 },
});
const assistant = (text, n = 1, stopReason = "stop", errorMessage) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "test",
	provider: "test",
	model: "test",
	usage: usage(n),
	stopReason,
	errorMessage,
	timestamp: Date.now(),
});
const record = (message) => {
	messages.push(message);
	fs.appendFileSync(sessionFile, `${JSON.stringify(message)}\n`);
	send({ type: "message_end", message });
};
const settle = () => send({ type: "agent_settled" });
let prompt;
if (scenario === "hang") process.on("SIGTERM", () => {});
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
	const req = JSON.parse(line);
	if (req.type === "get_commands")
		return response(req, { commands: scenario === "no-guard" ? [] : [{ name: "subagents-ex-guard" }] });
	if (req.type === "get_session_stats") {
		const totals = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
		for (const msg of messages) {
			for (const key of Object.keys(totals.tokens)) totals.tokens[key] += msg.usage?.[key] ?? 0;
			totals.cost += msg.usage?.cost.total ?? 0;
		}
		if (scenario === "extra-stats" && messages.length) {
			totals.cost += 0.3;
			totals.tokens.input += 30;
		}
		return response(req, totals);
	}
	if (req.type === "steer") {
		response(req);
		record(assistant(`steered: ${req.message}`));
		return settle();
	}
	if (req.type !== "prompt") return;
	prompt = req.message;
	response(req);
	if (scenario === "linger") setInterval(() => {}, 1000);
	if (scenario === "hang") {
		record(assistant("waiting", 1, "toolUse"));
		setInterval(() => {}, 1000);
		return;
	}
	if (scenario === "noise") {
		record(assistant("waiting", 1, "toolUse"));
		setInterval(() => {
			process.stderr.write("still alive\n");
			send({ type: "response", id: "unrelated", success: true, data: {} });
		}, 50);
		return;
	}
	if (scenario === "stream-progress" || scenario === "tool-progress") {
		if (scenario === "tool-progress")
			send({ type: "tool_execution_start", toolCallId: "working", toolName: "bash", args: {} });
		for (let i = 0; i < 12; i++) {
			await new Promise((r) => setTimeout(r, 75));
			send(
				scenario === "stream-progress"
					? { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "working" } }
					: { type: "tool_execution_update", toolCallId: "working", toolName: "bash", partialResult: {} },
			);
		}
		if (scenario === "tool-progress")
			send({ type: "tool_execution_end", toolCallId: "working", toolName: "bash", result: {}, isError: false });
	}
	if (["delegate-wait", "collection-wait", "delegate-then-hang"].includes(scenario)) {
		const toolName = scenario === "collection-wait" ? "subagent_task_output" : "subagent";
		send({ type: "tool_execution_start", toolCallId: "nested", toolName, args: {} });
		await new Promise((r) => setTimeout(r, 800));
		send({ type: "tool_execution_end", toolCallId: "nested", toolName, result: {}, isError: false });
		if (scenario === "delegate-then-hang") {
			setInterval(() => {}, 1000);
			return;
		}
	}
	if (scenario === "steer") {
		record(assistant("working", 1, "toolUse"));
		return;
	}
	if (scenario === "exit") return process.exit(2);
	if (scenario === "invalid-frame") {
		process.stdout.write("not json\n");
		return;
	}
	if (scenario === "recovered") {
		record(assistant("", 1, "error", "transient failure"));
		send({ type: "agent_end" }); // Not settled; pi may retry after this event.
		await new Promise((r) => setTimeout(r, 10));
		record(assistant("recovered", 2));
	} else if (scenario === "retry") {
		const first = sessionFile.endsWith("-1.jsonl");
		record(assistant(first ? '{"answer":"wrong type"}' : '{"answer":42}', first ? 1 : 2));
	} else if (scenario === "nested") {
		record({
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "nested",
			content: [{ type: "text", text: "nested output" }],
			details: { results: [{ treeId: process.env.PI_SUBAGENTS_EX_TREE_ID }] },
			isError: false,
			timestamp: Date.now(),
			usage: usage(4),
		});
		record(assistant("complete", 2));
	} else if (scenario === "utf8") {
		const message = assistant("日本語 🎉");
		messages.push(message);
		fs.appendFileSync(sessionFile, `${JSON.stringify(message)}\n`);
		const bytes = Buffer.from(`${JSON.stringify({ type: "message_end", message })}\n`);
		const cut = bytes.indexOf(Buffer.from("日")) + 1;
		process.stdout.write(bytes.subarray(0, cut));
		await new Promise((r) => setTimeout(r, 10));
		process.stdout.write(bytes.subarray(cut));
	} else {
		record(
			assistant(
				scenario === "large"
					? String(prompt.length)
					: scenario === "resume"
						? `history=${messages.length}`
						: "complete",
			),
		);
	}
	settle();
});
