// RPC peer with a same-group descendant whose SIGTERM handler is installed
// before the parent advertises readiness. Both pipe inheritance cases matter.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";

const [scenario, dir] = process.argv.slice(2);
const marker = (name, value = "ready") => fs.writeFileSync(path.join(dir, name), String(value));

if (scenario === "descendant") {
	process.on("SIGTERM", () => marker("descendant-term"));
	marker("descendant-pid", process.pid);
	setInterval(() => {}, 1000);
	process.send?.("ready", () => process.disconnect());
} else {
	const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
	const response = (req, data) => send({ type: "response", command: req.type, id: req.id, success: true, data });
	process.on("SIGTERM", () => {
		marker("leader-term");
		process.exit(0);
	});
	setInterval(() => {}, 1000);
	const rl = createInterface({ input: process.stdin });
	rl.on("close", () => {
		if (scenario === "settled-descendant") process.exit(0);
	});
	rl.on("line", async (line) => {
		const req = JSON.parse(line);
		if (req.type === "get_commands") return response(req, { commands: [{ name: "subagents-ex-guard" }] });
		if (req.type === "get_session_stats")
			return response(req, { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
		if (req.type !== "prompt") return response(req);
		const child = spawn(process.execPath, [process.argv[1], "descendant", dir], {
			stdio: ["ignore", scenario === "inherited-pipes" ? "inherit" : "ignore", "ignore", "ipc"],
		});
		await new Promise((resolve, reject) => {
			child.once("message", resolve);
			child.once("error", reject);
		});
		response(req);
		marker("ready");
		if (scenario === "unexpected-exit") process.exit(2);
		if (scenario === "settled-descendant") {
			send({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "complete" }],
					api: "test",
					provider: "test",
					model: "test",
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			send({ type: "agent_settled" });
		}
	});
}
