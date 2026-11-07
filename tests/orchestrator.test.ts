import { agent, defaults } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/plan.ts";
import { executePlan } from "../src/orchestrator.ts";
import { Runner } from "../src/runner.ts";
import { newRunRecord, type RunRecord, type SubagentDetails } from "../src/types.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { aggregateUsage, getFinalOutput, toModelUsage } from "../src/format.ts";
import { validateOutput } from "../src/contracts.ts";
import { MAX_RESULT_BYTES, MAX_RESULT_DETAILS_BYTES, MAX_RESULT_TEXT_BYTES, MAX_RESULT_TEXT_LINES } from "../src/results.ts";

test("parallel orchestration submits twenty tasks without a separate eight-worker throttle", async () => {
	const plan = buildPlan(
		{ tasks: Array.from({ length: 20 }, (_, i) => ({ agent: "test", task: `work-${i}` })) },
		[agent],
		defaults,
		null,
	);
	const runner = new Runner();
	let started = 0;
	let finish!: () => void;
	const waiting = new Promise<void>((resolve) => {
		finish = resolve;
	});
	runner.run = async (_defaults, agent, task) => {
		started++;
		await waiting;
		const run = newRunRecord(`run-${task}`, agent.name, agent.source, task, defaults.cwd);
		run.status = "ok";
		return run;
	};
	const pending = executePlan(plan, runner);
	try {
		assert.equal(started, 20);
	} finally {
		finish();
	}
	const result = await pending;
	assert.equal(result.details.status, "ok");
	assert.equal(result.details.results.length, 20);
});

function setOutput(run: RunRecord, output: string): void {
	run.messages = [{ role: "assistant", content: [{ type: "text", text: output }],
		api: "openai-completions", provider: "fixture", model: "fixture", usage: toModelUsage(run.usage),
		stopReason: "stop", timestamp: 1 } as Message];
}

function assertCompact(result: AgentToolResult<SubagentDetails>): void {
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_RESULT_BYTES);
	assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= MAX_RESULT_DETAILS_BYTES);
	const text = result.content[0];
	if (text.type !== "text") throw new Error("expected text result");
	assert.ok(Buffer.byteLength(text.text) <= MAX_RESULT_TEXT_BYTES);
	assert.ok(text.text.split("\n").length <= MAX_RESULT_TEXT_LINES);
	for (const record of result.details.results) {
		assert.equal(Object.hasOwn(record, "messages"), false);
		assert.equal(Object.hasOwn(record, "parsedOutput"), false);
		assert.equal(Object.keys(record.usage).length, 7);
	}
}

test("parallel progress and final publications stay compact and keep exact run provenance/accounting", async () => {
	const plan = buildPlan({ tasks: Array.from({ length: 32 }, (_, i) => ({ agent: "test", task: `work-${i}` })) }, [agent], defaults, null);
	const runner = new Runner();
	const records: RunRecord[] = [];
	const updates: AgentToolResult<SubagentDetails>[] = [];
	runner.run = async (_defaults, selected, task, _overrides, _step, _signal, update) => {
		const run = newRunRecord(`run-${task}`, selected.name, selected.source, task, defaults.cwd);
		run.treeId = `tree-${task}`;
		run.usage = { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, cost: 0.25, contextTokens: 15, turns: 16 };
		run.status = "running";
		setOutput(run, "🧪".repeat(12 * 1024));
		update?.(run);
		await Promise.resolve();
		run.status = "ok";
		run.usage.turns++;
		run.parsedOutput = { large: "x".repeat(48 * 1024) };
		records.push(run);
		return run;
	};
	const result = await executePlan(plan, runner, undefined, (update) => updates.push(update));
	assert.equal(updates.length, 32);
	for (const update of updates) assertCompact(update);
	assertCompact(result);
	assert.equal(result.details.results.length, 32);
	assert.equal(updates[0].details.results[0].status, "running", "later live-run mutation must not change published snapshots");
	assert.equal(updates[0].details.results[0].usage.turns, 16, "published usage must not alias the live run's usage");
	for (const record of records) {
		const published = result.details.results.find((r) => r.id === record.id)!;
		assert.equal(published.treeId, record.treeId);
		assert.deepEqual(published.usage, record.usage);
		assert.ok(getFinalOutput(record.messages).length > 4096);
	}
	assert.deepEqual(result.usage, toModelUsage(aggregateUsage(records)));
});

test("chain placeholders and JSON contracts use full records, not published previews", async () => {
	const schema = { type: "object", properties: { payload: { type: "string", minLength: 40_000 } }, required: ["payload"], additionalProperties: false };
	const plan = buildPlan({ chain: [{ agent: "test", task: "first" }, { agent: "test", task: "previous={previous}; step={steps.0}" }], outputSchema: schema }, [agent], defaults, null);
	const firstOutput = `full-start\n${"日本語🧪".repeat(12_000)}\nfull-end {previous}`;
	const finalOutput = JSON.stringify({ payload: "x".repeat(48 * 1024) });
	const records: RunRecord[] = [];
	const runner = new Runner();
	runner.run = async (_defaults, selected, task, overrides, step, _signal, update) => {
		if (step === 2) assert.equal(task, `previous=${firstOutput}; step=${firstOutput}`);
		const run = newRunRecord(`run-step-${step}`, selected.name, selected.source, task, defaults.cwd, step);
		run.status = "ok";
		setOutput(run, step === 1 ? firstOutput : finalOutput);
		if (overrides?.outputSchema) run.parsedOutput = validateOutput(getFinalOutput(run.messages), overrides.outputSchema);
		update?.(run);
		records.push(run);
		return run;
	};
	const result = await executePlan(plan, runner);
	assert.equal(result.details.status, "ok");
	assertCompact(result);
	assert.deepEqual(records[1].parsedOutput, JSON.parse(finalOutput));
	assert.equal(getFinalOutput(records[0].messages), firstOutput);
	assert.equal(result.details.results[0].outputTruncated, true);
	assert.equal(result.details.results[1].outputTruncated, true);
});
