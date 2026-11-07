// Deliberately do not call process.exit(): the test checks that Runner leaves no
// pending RPC timers, escalation timers, pipe handles, or budget intervals.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runner, RunStop } from "../../src/runner.ts";

const dir = process.argv[2];
const controller = new AbortController();
const runner = new Runner({
	invocation: {
		command: process.execPath,
		prefix: [fileURLToPath(new URL("./process-peer.mjs", import.meta.url)), "inherited-pipes", dir],
	},
	killGraceMs: 400,
});
const pending = runner.run(
	{ cwd: dir, depth: 0 },
	{
		name: "cleanup",
		description: "cleanup fixture",
		filePath: "cleanup.md",
		source: "user",
		systemPrompt: "Wait.",
		skills: false,
		contextFiles: false,
		extensions: false,
	},
	"wait",
	{},
	undefined,
	controller.signal,
);
const deadline = Date.now() + 5000;
while (!fs.existsSync(path.join(dir, "ready")) && Date.now() < deadline) await delay(10);
controller.abort(new RunStop("timeout", "Fixture deadline"));
const run = await pending;
fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(run));
