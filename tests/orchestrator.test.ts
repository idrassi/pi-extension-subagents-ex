import { agent, defaults } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../src/plan.ts";
import { executePlan } from "../src/orchestrator.ts";
import { Runner } from "../src/runner.ts";
import { newRunRecord } from "../src/types.ts";

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
