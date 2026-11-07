// Offline RPC peer: one assistant charge plus one durable native charge, then exit.
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

const session = process.argv[process.argv.indexOf("--session") + 1];
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const reply = (request, data) => send({ type: "response", id: request.id, success: true, data });
const usage = (input, output, cost) => ({
	input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
	cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const native = { type: "usage", id: "fault-native", usage: usage(20, 10, 0.25) };
const message = {
	role: "assistant", content: [{ type: "text", text: "fault fixture complete" }],
	api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
	usage: usage(10, 5, 0.125),
};
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "get_commands")
		return reply(request, { commands: [{ name: "subagents-ex-guard" }] });
	if (request.type === "get_session_stats")
		return reply(request, { tokens: { input: 30, output: 15, cacheRead: 0, cacheWrite: 0 }, cost: 0.375 });
	if (request.type !== "prompt") return;
	reply(request);
	fs.writeFileSync(path.join(process.cwd(), "worker.txt"), "worker output\n");
	fs.appendFileSync(session, `${JSON.stringify(native)}\n${JSON.stringify({ type: "message", id: "fault-assistant", message })}\n`);
	send({ type: "entry_appended", entry: native });
	send({ type: "message_end", message });
	send({ type: "agent_settled" });
});
