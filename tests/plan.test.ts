import { agent, defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildPlan, expandTask, type PlanInput } from "../src/plan.ts";
import { newRunRecord, THINKING_LEVELS } from "../src/types.ts";
import { validateOutput } from "../src/contracts.ts";
import { getFinalOutput, truncateToBytes } from "../src/format.ts";
import { discoverAgents } from "../src/agents.ts";

test("normalization applies top-level isolation and per-task overrides consistently", () => {
	const plan = buildPlan(
		{
			isolation: "worktree",
			timeout: 20,
			tasks: [
				{ agent: "test", task: "one" },
				{ agent: "test", task: "two", isolation: "none", timeout: 10 },
			],
		},
		[agent],
		defaults,
		null,
	);
	assert.equal(plan.steps[0].overrides.isolation, "worktree");
	assert.equal(plan.steps[1].overrides.isolation, "none");
	assert.equal(plan.steps[1].overrides.timeoutSeconds, 10);
	const single = buildPlan({ agent: "test", task: "work", cwd: "relative" }, [agent], defaults, null);
	assert.equal(single.steps[0].overrides.cwd, path.join(temp, "relative"));
});

test("all bundled agents inherit the parent's model and thinking level", () => {
	const { agents, errors } = discoverAgents(temp, "user");
	assert.deepEqual(errors, []);
	assert.deepEqual(agents.map((a) => a.name).sort(), ["planner", "reviewer", "scout", "tester", "worker"]);
	for (const thinkingLevel of THINKING_LEVELS) {
		const plan = buildPlan(
			{ tasks: agents.map((a) => ({ agent: a.name, task: "work" })) },
			agents,
			{ ...defaults, model: "parent/model", thinkingLevel },
			null,
		);
		for (const { agent, overrides } of plan.steps) {
			assert.equal(overrides.model, "parent/model", agent.name);
			assert.equal(overrides.thinking, thinkingLevel, agent.name);
		}
	}
});

test("bundled agents have no turn or elapsed-time caps unless explicitly requested", () => {
	const { agents } = discoverAgents(temp, "user");
	const input = { tasks: agents.map((a) => ({ agent: a.name, task: "work" })) };
	for (const { overrides } of buildPlan(input, agents, defaults, null).steps) {
		assert.equal(overrides.maxTurns, undefined);
		assert.equal(overrides.timeoutSeconds, undefined);
		assert.equal(overrides.maxCost, undefined);
	}
	for (const { overrides } of buildPlan({ ...input, maxTurns: 5, timeout: 30 }, agents, defaults, null).steps) {
		assert.equal(overrides.maxTurns, 5);
		assert.equal(overrides.timeoutSeconds, 30);
	}
});

test("parallel batches can fill the default pool and remain bounded at thirty-two tasks", () => {
	const tasks = Array.from({ length: 32 }, (_, i) => ({ agent: "test", task: `work ${i}` }));
	assert.equal(buildPlan({ tasks }, [agent], defaults, null).steps.length, 32);
	assert.throws(() => buildPlan({ tasks: [...tasks, tasks[0]] }, [agent], defaults, null), /1–32/);
});

test("thinking inheritance is independent of model overrides in every execution mode", () => {
	const parent = { ...defaults, model: "parent/model", thinkingLevel: "max" as const };
	for (const model of [undefined, "agent/model"]) {
		for (const input of [
			{ agent: "test", task: "work" },
			{ agent: "test", task: "work", model: "call/model" },
			{ agent: "test", task: "work", model: "call/model", runInBackground: true },
			{ tasks: [{ agent: "test", task: "work", model: "task/model" }] },
			{ tasks: [{ agent: "test", task: "work" }], model: "call/model" },
			{ chain: [{ agent: "test", task: "work", model: "step/model" }] },
			{ chain: [{ agent: "test", task: "work" }], model: "call/model" },
		]) {
			const plan = buildPlan(input, [{ ...agent, model }], parent, null);
			assert.equal(plan.steps[0].overrides.thinking, "max", JSON.stringify({ model, input }));
		}
	}
});

test("explicit thinking overrides take priority over inherited levels, including off", () => {
	const agents = [agent, { ...agent, name: "specialist", model: "other/model", thinking: "low" as const }];
	for (const mode of ["tasks", "chain"] as const) {
		const items = [
			{ agent: "test", task: "inherit parent" },
			{ agent: "specialist", task: "inherit agent" },
			{ agent: "specialist", task: "override agent", thinking: "off" as const },
			{ agent: "test", task: "override call", thinking: "max" as const },
		];
		const parent = { ...defaults, thinkingLevel: "high" as const };
		const input: PlanInput = { [mode]: items };
		const plan = buildPlan(input, agents, parent, null);
		assert.deepEqual(plan.steps.map((step) => step.overrides.thinking), ["high", "low", "off", "max"]);
		const overridden = buildPlan({ ...input, thinking: "xhigh" }, agents, parent, null);
		assert.deepEqual(overridden.steps.map((step) => step.overrides.thinking), ["xhigh", "xhigh", "off", "max"]);
	}
	const unspecified = buildPlan({ agent: "test", task: "work" }, agents, defaults, null);
	assert.equal(unspecified.steps[0].overrides.thinking, undefined);
});

test("plans reject invalid modes, unknown agents, and numeric controls before execution", () => {
	for (const input of [
		{},
		{ agent: "test", task: "work", tasks: [] },
		{ tasks: [] },
		{ agent: "missing", task: "work" },
		...[-1, 0.5, NaN, Infinity, 4].map((retries) => ({ agent: "test", task: "work", retries })),
		...[-1, 0, 1.5, Infinity].map((maxTurns) => ({ agent: "test", task: "work", maxTurns })),
		{ agent: "test", task: "work", timeout: -1 },
		{ agent: "test", task: "work", timeout: 3_000_000 },
		{ chain: [{ agent: "test", task: "work", isolation: "worktree" as const }] },
	])
		assert.throws(() => buildPlan(input, [agent], defaults, null));
	assert.equal(
		buildPlan({ agent: "test", task: "work", retries: 0 }, [agent], defaults, null).steps[0].overrides.retries,
		0,
	);
	assert.throws(
		() => buildPlan({ agent: "test", task: "work", retries: "1" } as any, [agent], defaults, null),
		/number/,
	);
	assert.throws(
		() => buildPlan({ chain: [{ agent: "test", task: "use {steps.0}" }] }, [agent], defaults, null),
		/unavailable step/,
	);
});

test("chain substitutions are literal and never expand inserted placeholders", () => {
	const run = newRunRecord("run-test", "test", "user", "task", temp);
	const literal = "$& $' $` {previous} {steps.9}";
	run.messages = [{ role: "assistant", content: [{ type: "text", text: literal }] } as any];
	assert.equal(expandTask("before {previous} after {steps.0}", [run]), `before ${literal} after ${literal}`);
	assert.throws(() => expandTask("{steps.1}", [run]), /unavailable step/);
});

test("schema contracts reject prose, fenced JSON, and wrong types", () => {
	const schema = {
		type: "object",
		properties: { ok: { type: "boolean" } },
		required: ["ok"],
		additionalProperties: false,
	};
	assert.deepEqual(validateOutput('{"ok":true}', schema), { ok: true });
	for (const output of ['```json\n{"ok":true}\n```', 'Here: {"ok":true}', '{"ok":"yes"}', "{}"])
		assert.throws(() => validateOutput(output, schema));
	assert.throws(() =>
		buildPlan({ agent: "test", task: "work", outputSchema: { type: "made-up" } }, [agent], defaults, null),
	);
});

test("final output combines the last assistant's text and never reuses stale output", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "stale" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "part one" },
				{ type: "text", text: "part two" },
			],
		},
	] as any;
	assert.equal(getFinalOutput(messages), "part one\npart two");
	messages.push({ role: "assistant", content: [] });
	assert.equal(getFinalOutput(messages), "");
	for (let bytes = 0; bytes < 12; bytes++) {
		const result = truncateToBytes("日🎉éabc", bytes);
		assert.ok(Buffer.byteLength(result.text) <= bytes);
		assert.ok(!result.text.includes("�"));
	}
});

test("invalid frontmatter is reported and does not silently apply a broken budget", () => {
	const dir = path.join(temp, ".pi", "agents");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "bad.md"), "---\nname: bad\ndescription: bad agent\nmaxTurns: -1\n---\nwork");
	const discovery = discoverAgents(temp, "both");
	assert.ok(!discovery.agents.some((a) => a.name === "bad"));
	assert.match(discovery.errors.join("\n"), /maxTurns/);
});
