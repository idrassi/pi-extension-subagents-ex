// Deterministic RPC peer for lost frames, native entries, startup/shutdown writes,
// and observations shared with the actual child-side scheduler ledger.
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import { Scheduler } from "../../src/scheduler.ts";
import { messageUsageKey, nativeUsageKey, usageStats } from "../../src/accounting.ts";

const scenario = process.argv[2];
const file = process.argv[process.argv.indexOf("--session") + 1];
const namespace = process.env.PI_SUBAGENTS_EX_TASK_NAMESPACE;
const scheduler = new Scheduler();
const owner = process.env.PI_SUBAGENTS_EX_LEASE_ID;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const usage = (n) => ({ input: 10 * n, output: 5 * n, cacheRead: 0, cacheWrite: 0, totalTokens: 15 * n,
	cost: { input: 0.01 * n, output: 0.09 * n, cacheRead: 0, cacheWrite: 0, total: 0.1 * n } });
const entries = () => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd: process.cwd() }) + "\n");
function append(value) {
	const entry = { id: randomUUID(), parentId: entries().at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...value };
	fs.appendFileSync(file, JSON.stringify(entry) + "\n");
	return entry;
}
function stats() {
	const usages = entries().map((entry) => entry.message?.usage ?? entry.usage).filter(Boolean);
	if (prompted && ["startup-stats-only", "receipt-stats-only", "late-stats-only", "shutdown-stats-only"].includes(scenario)) usages.push(usage(3));
	const sum = (key) => usages.reduce((total, value) => total + value[key], 0);
	return { tokens: { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") },
		cost: usages.reduce((total, value) => total + value.cost.total, 0) };
}
if (["startup", "startup-stats-only"].includes(scenario))
	append({ type: "usage", kind: "startup", provider: "fixture", model: "mock", usage: usage(4) });
let prompted = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
	const request = JSON.parse(line);
	const reply = (data) => send({ type: "response", id: request.id, command: request.type, success: true, data });
	if (request.type === "get_commands") return reply({ commands: [{ name: "subagents-ex-guard" }] });
	if (request.type === "get_session_stats") {
		if (prompted && ["late-stats", "late-stats-only"].includes(scenario)) append({ type: "compaction", summary: "late", usage: usage(4) });
		return reply(stats());
	}
	if (request.type !== "prompt") return reply({});
	prompted = true;
	if (scenario === "receipt-stats-only") {
		// Background work is already billed, but its custom receipt is not part of
		// pi's session statistics and must not hide unrelated stats-only usage.
		append({ type: "custom", customType: "subagents-ex-accounting", data: { taskIds: [randomUUID()], usage: usage(2) } });
		await scheduler.addUsage(owner, usageStats(usage(2)), `background:${namespace}`);
	}
	if (["cancel", "crash", "complete"].includes(scenario)) {
		for (const [type, n] of [["usage", 2], ["compaction", 3], ["branch_summary", 4]]) {
			const entry = append({ type, usage: usage(n) });
			// The guard already saw two entries. Recovery must not debit them again.
			if (n !== 4) await scheduler.addUsage(owner, usageStats(entry.usage), nativeUsageKey(entry, namespace));
		}
	}
	const message = { role: "assistant", api: "openai-completions", provider: "fixture", model: "mock",
		content: [{ type: "text", text: "durable fixture" }], stopReason: "stop", timestamp: Date.now(), usage: usage(1),
		subagentsExUsageEventId: randomUUID(), subagentsExBudgetAccounted: true };
	append({ type: "message", message });
	await scheduler.addUsage(owner, usageStats(message.usage), messageUsageKey(message, namespace));
	reply({});
	if (scenario === "crash") return process.kill(process.pid, "SIGKILL");
	if (scenario === "cancel") {
		// Force the runner's hard-kill path; stdout never completes this frame.
		process.on("SIGTERM", () => {});
		process.stdout.write('{"type":"message_end",');
		return;
	}
	send({ type: "entry_appended", entry: entries().at(-1) });
	send({ type: "message_end", message });
	send({ type: "agent_settled" });
});
rl.on("close", () => {
	if (prompted && ["shutdown-late", "shutdown-stats-only"].includes(scenario)) append({ type: "branch_summary", summary: "shutdown", usage: usage(4) });
	process.exit(0);
});
