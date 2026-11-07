import { defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import childGuard from "../src/child-guard.ts";
import { estimateContextTokens } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import {
	ManagedUsageTracker, UsageLedger, copySessionForResume, directUsage, messageUsageKey, nativeUsage,
	nativeUsageKey, readAccountingEntries, readSessionEntries, usageStats,
	type AccountedMessage,
} from "../src/accounting.ts";
import { Scheduler } from "../src/scheduler.ts";
import { TaskManager, serializeTask } from "../src/tasks.ts";
import { emptyUsage, newRunRecord } from "../src/types.ts";

function modelUsage(cost: number, tokens = 100): Usage {
	return { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function tool(toolCallId = "wrapper", cost = 0.6): Extract<AccountedMessage, { role: "toolResult" }> {
	return { role: "toolResult", toolCallId, toolName: "arbitrary-wrapper", content: [],
		isError: false, timestamp: 1, usage: modelUsage(cost, 600) };
}
function result(id: string, treeId: string, cost: number, tokens = 100) {
	return { usage: modelUsage(cost, tokens), details: { results: [{ id, treeId, usage: { ...usageStats(modelUsage(cost, tokens)) } }] } };
}

test("execution provenance survives arbitrary nested wrappers and deduplicates managed runs", () => {
	const tracker = new ManagedUsageTracker();
	const tree = "tree";
	tracker.observe({ toolCallId: "wrapper", toolName: "not-codemode" }, tree);
	tracker.observe({ toolCallId: "inner", parentToolCallId: "wrapper", toolName: "another-wrapper" }, tree);
	tracker.observe({ toolCallId: "leaf", parentToolCallId: "inner", toolName: "subagent", result: result("one", tree, 0.2, 200) }, tree);
	// Repeated output/collection of the same run must not multiply its usage.
	tracker.observe({ toolCallId: "repeat", parentToolCallId: "wrapper", toolName: "subagent", result: result("one", tree, 0.2, 200) }, tree);
	tracker.observe({ toolCallId: "two", parentToolCallId: "wrapper", toolName: "subagent", result: result("two", tree, 0.1, 100) }, tree);
	tracker.observe({ toolCallId: "unmanaged", parentToolCallId: "inner", toolName: "subagent", result: result("external", "other-tree", 0.15) }, tree);
	const annotated = tracker.annotate(tool(), tree);
	assert.ok(Math.abs(annotated.subagentsExManagedUsage!.usage.cost.total - 0.3) < 1e-12);
	assert.ok(Math.abs(directUsage(annotated, tree).cost - 0.3) < 1e-12);
	assert.equal(directUsage(annotated, tree).input, 300);
	assert.equal(directUsage(annotated, "other-tree").cost, 0.6);
	assert.equal(tracker.annotate(tool(), tree).subagentsExManagedUsage, undefined);
	tracker.observe({ toolCallId: "later", toolName: "subagent", result: result("later", tree, 0.2) }, tree);
	tracker.clear();
	assert.equal(tracker.annotate(tool("later"), tree).subagentsExManagedUsage, undefined);
});

test("managed attribution does not depend on the SDK's bounded nestedCalls result metadata", () => {
	const tracker = new ManagedUsageTracker();
	tracker.observe({ toolCallId: "wrapper", toolName: "unbounded-wrapper" }, "tree");
	for (let i = 0; i < 1100; i++)
		tracker.observe({ toolCallId: `leaf-${i}`, parentToolCallId: "wrapper", toolName: "subagent", result: result(`run-${i}`, "tree", 1, 1) }, "tree");
	const annotated = tracker.annotate(tool("wrapper", 1101), "tree");
	assert.equal(annotated.subagentsExManagedUsage!.usage.cost.total, 1100);
	assert.equal(directUsage(annotated, "tree").cost, 1);
});

test("direct subagent results subtract only same-tree runs, retaining unrelated usage", () => {
	const message = { ...tool(), toolName: "subagent", details: { results: [
		...result("managed", "tree", 0.2, 200).details.results,
		...result("external", "other", 0.4, 400).details.results,
	] } };
	assert.ok(Math.abs(directUsage(message, "tree").cost - 0.4) < 1e-12);
	assert.equal(directUsage(message, "tree").input, 400);
});

test("free collection and unrelated wrapper metadata never suppress billable tool usage", () => {
	const tracker = new ManagedUsageTracker();
	const { details } = result("already-receipted", "tree", 0.2);
	tracker.observe({ toolCallId: "wrapper", toolName: "wrapper" }, "tree");
	tracker.observe({ toolCallId: "collect", parentToolCallId: "wrapper", toolName: "subagent_task_output", result: { details } }, "tree");
	tracker.observe({ toolCallId: "charge", parentToolCallId: "wrapper", toolName: "unrelated", result: { details, usage: modelUsage(0.1) } }, "tree");
	// Even a direct subagent result without reported usage is not a new charge.
	tracker.observe({ toolCallId: "free", parentToolCallId: "wrapper", toolName: "subagent", result: { details } }, "tree");
	const message = tracker.annotate({ ...tool("wrapper", 0.1), details }, "tree");
	assert.equal(message.subagentsExManagedUsage, undefined);
	assert.equal(directUsage(message, "tree").cost, 0.1);
});

test("unrelated and malformed run metadata is unmanaged, not an accounting failure", () => {
	const tracker = new ManagedUsageTracker();
	const invalid = [null, undefined, 4, "run", [], {}, { treeId: "tree", usage: {} },
		{ treeId: "tree", id: "" }, { treeId: "tree", id: 4 },
		{ treeId: "tree", id: "", usage: emptyUsage() },
		{ treeId: "tree", usage: { ...emptyUsage(), cost: -1 } },
		{ treeId: "tree", usage: { ...emptyUsage(), input: NaN } }];
	for (const candidate of invalid) {
		for (const toolName of ["unrelated", "subagent"]) {
			const message = { ...tool("wrapper", 0.1), toolName, details: { results: [candidate] } } as Extract<AccountedMessage, { role: "toolResult" }>;
			tracker.observe({ toolCallId: "wrapper", toolName, result: message }, "tree");
			const annotated = tracker.annotate(message, "tree");
			assert.equal(annotated.subagentsExManagedUsage, undefined);
			assert.equal(directUsage(annotated, "tree").cost, 0.1);
		}
	}
	for (const id of ["legacy-one", "legacy-two"])
		tracker.observe({ toolCallId: id, parentToolCallId: "wrapper", toolName: "subagent",
			result: { usage: modelUsage(0.1), details: { results: [{ id, treeId: "tree" }] } } }, "tree");
	assert.ok(Math.abs(directUsage(tracker.annotate(tool("wrapper", 0.3), "tree"), "tree").cost - 0.1) < 1e-12);
});

test("background completion leaves provider usage and pi's context estimate unchanged", async () => {
	const manager = new TaskManager(randomUUID());
	const task = manager.start("single", "large background result", false, async () => {
		const run = newRunRecord("background", "test", "user", "background", defaults.cwd);
		run.status = "ok";
		run.usage = { ...emptyUsage(), input: 150000, cost: 1 };
		return { content: [], details: { mode: "single", status: "ok", results: [run], agentScope: "user", projectAgentsDir: null } };
	});
	await task.done;
	const assistant: AccountedMessage = {
		role: "assistant", api: "openai-completions", provider: "fixture", model: "mock", content: [],
		stopReason: "stop", timestamp: 1, usage: modelUsage(0.1, 2000),
	};
	const before = structuredClone(assistant);
	const ledger = new UsageLedger();
	assert.equal(ledger.apply(assistant, [], [task]), undefined);
	assert.deepEqual(assistant, before);
	assert.equal(estimateContextTokens([assistant]).tokens, 2000);
	const receipt = ledger.apply(tool("next", 0.1), [], [task])!;
	assert.equal(receipt.role, "toolResult");
	if (receipt.role !== "toolResult") throw new Error("expected a tool receipt");
	assert.equal(receipt.subagentsExAccounting!.usage.input, 150000);
	assert.equal(receipt.usage!.input, 150600);
	assert.equal(estimateContextTokens([assistant, receipt]).tokens, estimateContextTokens([assistant, tool("next", 0.1)]).tokens);
	assert.equal(directUsage(receipt, "tree").cost.toFixed(6), "0.100000");
	assert.equal(ledger.apply(tool("later"), [], [task]), undefined);
	const restarted = new UsageLedger();
	assert.equal(restarted.claim([{ type: "custom", customType: "subagents-ex-accounting", data: receipt.subagentsExAccounting }], [task]), undefined);
});

test("usage receipts are atomically deduplicated across independent scheduler observers", async () => {
	const scheduler = new Scheduler();
	const release = await scheduler.acquire("owner");
	try {
		const other = new Scheduler(scheduler.id);
		const usage = usageStats(modelUsage(0.25));
		await Promise.all(Array.from({ length: 15 }, (_, i) => (i % 2 ? other : scheduler).addUsage("owner", usage, "shared-event")));
		assert.equal((await scheduler.snapshot()).cost, 0.25);
		assert.equal((await scheduler.subtreeUsage("owner")).input, 100);
		await other.addUsage("owner", usage, "__proto__");
		await scheduler.addUsage("owner", usage, "__proto__");
		assert.equal((await scheduler.snapshot()).cost, 0.5);
		await scheduler.addUsage("owner", usage, "different-attempt");
		assert.equal((await scheduler.snapshot()).cost, 0.75);
		for (const invalid of ["", "x".repeat(513), 42])
			await assert.rejects(() => scheduler.addUsage("owner", usage, invalid as string), /Invalid usage event id/);
		await assert.rejects(() => scheduler.addUsage("owner", { ...usage, cost: NaN }, "bad-usage"), /Invalid reported usage/);
		assert.equal((await scheduler.snapshot()).cost, 0.75);
	} finally { await release(); }
});

test("concurrent native guard observations do not consume the local run budget more than once", async () => {
	const scheduler = new Scheduler();
	await scheduler.acquire("run");
	const env = { PI_SUBAGENTS_EX_TREE_ID: scheduler.id, PI_SUBAGENTS_EX_LEASE_ID: "run",
		PI_SUBAGENTS_EX_PARENT_PID: "0", PI_SUBAGENTS_EX_TASK_NAMESPACE: "native-concurrent", PI_SUBAGENTS_EX_RUN_COST: "0.5" };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	let aborted = false;
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const ctx = { sessionManager: { getEntries: () => [{ type: "usage", id: "concurrent", usage: modelUsage(0.4) }] },
		abort() { aborted = true; } } as unknown as ExtensionContext;
	try {
		childGuard({ registerCommand() {}, appendEntry() {}, on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(name, fn) } as unknown as ExtensionAPI);
		await Promise.all(Array.from({ length: 8 }, () => hooks.get("session_compact")!({}, ctx)));
		await hooks.get("turn_start")!({}, ctx);
		assert.equal(aborted, false, "duplicate observations must not exhaust the $0.50 local budget");
		const snapshot = await scheduler.snapshot();
		assert.equal(snapshot.cost, 0.4);
		assert.equal(snapshot.turns, 1);
	} finally {
		await scheduler.release("run");
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("session parsing recovers only an incomplete JSONL tail and preserves native usage kinds", () => {
	const file = path.join(temp, `${randomUUID()}.jsonl`);
	const entries = [
		{ type: "usage", id: "u", usage: modelUsage(0.1) },
		{ type: "compaction", id: "c", usage: modelUsage(0.2) },
		{ type: "branch_summary", id: "b", usage: modelUsage(0.3) },
		{ type: "custom", id: "receipt", customType: "subagents-ex-accounting", data: { taskIds: ["task"], usage: modelUsage(0.4) } },
	];
	const complete = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	fs.writeFileSync(file, complete + '{"type":"usage",');
	assert.deepEqual(readSessionEntries(file), entries);
	assert.deepEqual(readAccountingEntries(file), [{ id: "receipt", data: entries[3].data }]);
	assert.deepEqual(entries.map(nativeUsage).map((usage) => usage?.cost.total), [0.1, 0.2, 0.3, undefined]);
	assert.equal(nativeUsageKey(entries[0], "one"), "entry:one:u");
	assert.notEqual(nativeUsageKey(entries[0], "one"), nativeUsageKey(entries[0], "two"));
	fs.writeFileSync(file, complete.trimEnd());
	assert.deepEqual(readSessionEntries(file), entries);
	fs.writeFileSync(file, complete + "broken\n");
	assert.throws(() => readSessionEntries(file), /Invalid session record.*:5/);
	fs.writeFileSync(file, "broken\n" + complete);
	assert.throws(() => readAccountingEntries(file), /Invalid session record.*:1/);
	assert.deepEqual(readSessionEntries(path.join(temp, "absent-session")), []);
	assert.throws(() => readSessionEntries(temp));
});

test("continuation copies discard only incomplete tails and preserve the original", () => {
	const source = path.join(temp, `${randomUUID()}.jsonl`);
	const target = path.join(temp, `${randomUUID()}.jsonl`);
	const complete = JSON.stringify({ type: "message", id: "unicode", message: { role: "user", content: "£ 🧪" } });
	for (const suffix of ["", "\n", '\n{"unfinished":']) {
		fs.writeFileSync(source, complete + suffix);
		const original = fs.readFileSync(source);
		copySessionForResume(source, target);
		assert.equal(fs.readFileSync(target, "utf8"), suffix.startsWith("\n") ? complete + "\n" : complete);
		assert.deepEqual(fs.readFileSync(source), original);
	}
	fs.writeFileSync(source, complete + '\nnot-json\n{"unfinished":');
	assert.throws(() => copySessionForResume(source, target), /Invalid session record.*:2/);
	fs.writeFileSync(source, complete + '\n{"unfinished":\n');
	assert.throws(() => copySessionForResume(source, target), /Invalid session record.*:2/);
});

test("message identities survive observer annotations while distinct attempts still charge", () => {
	const message = tool();
	const annotated = { ...message, subagentsExBudgetAccounted: true, subagentsExManagedUsage: { treeId: "tree", usage: modelUsage(0.2) } };
	assert.equal(messageUsageKey(message, "one"), messageUsageKey(annotated, "one"));
	assert.notEqual(messageUsageKey(message, "one"), messageUsageKey(message, "two"));
	const identified = { ...annotated, subagentsExUsageEventId: randomUUID() };
	assert.equal(messageUsageKey(identified, "one"), messageUsageKey({ ...identified, content: [{ type: "text", text: "enriched" }] }, "one"));
	assert.notEqual(messageUsageKey(identified, "one"), messageUsageKey({ ...identified, subagentsExUsageEventId: randomUUID() } as AccountedMessage, "one"));
});

test("copied session UUIDs do not transfer background-task ownership between sibling attempts", async () => {
	const session = randomUUID();
	const first = new TaskManager(session, "run-one-1");
	const task = first.start("single", "branch-local work", false, async () => ({
		content: [], details: { mode: "single", status: "ok", results: [], agentScope: "user", projectAgentsDir: null },
	}));
	await task.done;
	assert.deepEqual(serializeTask(task).owner, { sessionId: session, runNamespace: "run-one-1" });
	assert.equal(new TaskManager(session, "run-one-1").get(task.id)!.id, task.id);
	assert.equal(new TaskManager(session, "run-two-1").get(task.id), undefined);
	assert.equal(new TaskManager(session, "run-one-2").get(task.id), undefined);
	assert.equal(new TaskManager(session).get(task.id), undefined);
	const top = new TaskManager(session);
	const rootTask = top.start("single", "top-level work", false, async () => ({
		content: [], details: { mode: "single", status: "ok", results: [], agentScope: "user", projectAgentsDir: null },
	}));
	await rootTask.done;
	assert.equal(new TaskManager(session).get(rootTask.id)!.id, rootTask.id);
	assert.equal(new TaskManager(session, "run-two-1").get(rootTask.id), undefined);
});
