import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";

export const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ex-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(temp, "agent");
// Tests must not inherit the dispatcher/worker environment running the suite.
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENTS_EX_")) delete process.env[key];
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
fs.writeFileSync(
	path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
	JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, packages: [] }),
);
after(() => fs.rmSync(temp, { recursive: true, force: true }));

export const agent = {
	name: "test",
	description: "Test worker",
	systemPrompt: "Complete the task.",
	source: "user" as const,
	filePath: "test.md",
	skills: false,
	contextFiles: false,
	extensions: false,
};
export const defaults = { cwd: temp, depth: 0 };
