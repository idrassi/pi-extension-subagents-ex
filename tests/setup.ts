import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";

export const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-ex-test-"));
process.env.PI_CODING_AGENT_DIR = path.join(temp, "agent");
delete process.env.PI_SUBAGENTS_EX_TREE_ID;
delete process.env.PI_SUBAGENTS_EX_LEASE_ID;
delete process.env.PI_SUBAGENTS_EX_PARENT_PID;
delete process.env.PI_SUBAGENTS_EX_POLICY;
for (const key of ["CONCURRENCY", "MAX_RUNS", "MAX_TOTAL_TURNS", "MAX_COST", "STALL_TIMEOUT_MS"])
	delete process.env[`PI_SUBAGENTS_EX_${key}`];
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
