import { agent, defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Runner, type RunnerOptions } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { getFinalOutput } from "../src/format.ts";
import type { RunDefaults, RunOverrides } from "../src/types.ts";

const cli = path.join(
	path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle/cli.js",
);
const provider = fileURLToPath(new URL("./fixtures/mock-provider.ts", import.meta.url));
const runnerFor = (scheduler = new Scheduler(), options: RunnerOptions = {}) =>
	new Runner({
		scheduler,
		invocation: { command: process.execPath, prefix: [cli, "--extension", provider] },
		killGraceMs: 1000,
		...options,
	});
const worker = { ...agent, tools: ["bash"], model: "subagents-test/fixture" };
process.env.SUBAGENTS_TEST_PROVIDER_LOG = path.join(temp, "provider.jsonl");
const calls = () =>
	fs.existsSync(process.env.SUBAGENTS_TEST_PROVIDER_LOG!)
		? fs.readFileSync(process.env.SUBAGENTS_TEST_PROVIDER_LOG!, "utf8").trim().split("\n").filter(Boolean).length
		: 0;

function installFixtureExtensions() {
	const extDir = path.join(process.env.PI_CODING_AGENT_DIR!, "extensions");
	const agentsDir = path.join(process.env.PI_CODING_AGENT_DIR!, "agents");
	fs.mkdirSync(extDir, { recursive: true });
	fs.mkdirSync(agentsDir, { recursive: true });
	const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
	fs.writeFileSync(path.join(extDir, "subagents.ts"), `export { default } from ${JSON.stringify(extension)};`);
	fs.writeFileSync(path.join(extDir, "provider.ts"), `export { default } from ${JSON.stringify(provider)};`);
	fs.writeFileSync(
		path.join(agentsDir, "fixture-child.md"),
		"---\nname: fixture-child\ndescription: local test child\nmodel: subagents-test/fixture\nskills: false\ncontextFiles: false\nmaxTurns: 2\ntimeout: 10\n---\nComplete the fixture.",
	);
	return extDir;
}

test(
	"real pi RPC loads explicit guard with --no-extensions and resumes saved sessions",
	{ timeout: 20000 },
	async () => {
		const runner = runnerFor();
		const run = await runner.run(defaults, worker, "complete the fixture", { timeoutSeconds: 10 });
		assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
		assert.match(getFinalOutput(run.messages), /fixture complete/);
		assert.equal(run.usage.cost, 0.01);
		assert.equal((await runner.scheduler.snapshot()).turns, 1);
		const resumed = await runner.run(defaults, worker, "follow up", { resumeFrom: run, timeoutSeconds: 10 });
		assert.equal(resumed.status, "ok", `${resumed.errorMessage}\n${resumed.stderr}`);
		assert.equal(resumed.usage.cost, 0.01);
		assert.ok(
			Number(getFinalOutput(resumed.messages).split("history=")[1]) >
				Number(getFinalOutput(run.messages).split("history=")[1]),
		);
	},
);

test("real pi applies inherited and explicit thinking to the selected child model", { timeout: 60000 }, async (t) => {
	const reasoningModel = "subagents-test/fixture-reasoning";
	const cases: {
		name: string;
		agentModel?: string;
		agentThinking?: RunOverrides["thinking"];
		parentThinking?: RunDefaults["thinkingLevel"];
		overrides?: RunOverrides;
		expectedModel: string;
		expectedThinking?: RunOverrides["thinking"];
	}[] = [
		{
			name: "model override inherits max",
			agentModel: worker.model,
			overrides: { model: reasoningModel },
			expectedModel: "fixture-reasoning",
			expectedThinking: "max",
		},
		{
			name: "agent model inherits xhigh",
			agentModel: reasoningModel,
			parentThinking: "xhigh",
			expectedModel: "fixture-reasoning",
			expectedThinking: "xhigh",
		},
		{
			name: "agent thinking overrides parent",
			agentModel: reasoningModel,
			agentThinking: "low",
			expectedModel: "fixture-reasoning",
			expectedThinking: "low",
		},
		{
			name: "explicit off overrides agent and parent",
			agentModel: reasoningModel,
			agentThinking: "low",
			overrides: { thinking: "off" },
			expectedModel: "fixture-reasoning",
		},
		{
			name: "explicit max overrides parent low with inherited model",
			parentThinking: "low",
			overrides: { thinking: "max" },
			expectedModel: "fixture-reasoning",
			expectedThinking: "max",
		},
		{
			name: "pi clamps unsupported max to high",
			agentModel: "subagents-test/fixture-limited-reasoning",
			expectedModel: "fixture-limited-reasoning",
			expectedThinking: "high",
		},
		{
			name: "pi disables thinking for models without reasoning",
			agentModel: worker.model,
			expectedModel: "fixture",
		},
	];
	for (const scenario of cases) {
		await t.test(scenario.name, { timeout: 15000 }, async () => {
			const before = calls();
			const run = await runnerFor().run(
				{ ...defaults, model: reasoningModel, thinkingLevel: scenario.parentThinking ?? "max" },
				{ ...worker, model: scenario.agentModel, thinking: scenario.agentThinking },
				"complete the fixture",
				{ timeoutSeconds: 10, ...scenario.overrides },
			);
			assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
			const requests = fs
				.readFileSync(process.env.SUBAGENTS_TEST_PROVIDER_LOG!, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.slice(before)
				.map((line) => JSON.parse(line));
			assert.equal(requests.length, 1);
			assert.equal(requests[0].model, scenario.expectedModel);
			assert.equal(requests[0].reasoning, scenario.expectedThinking);
		});
	}
});

test("real turn guard prevents the third provider call and captures bash evidence", { timeout: 15000 }, async () => {
	const before = calls();
	const run = await runnerFor().run(defaults, worker, "LOOP_TOOLS", { maxTurns: 2, timeoutSeconds: 10 });
	assert.equal(run.status, "max-turns", `${run.errorMessage}\n${run.stderr}`);
	assert.equal(calls() - before, 2);
	assert.equal(run.usage.turns, 2);
	assert.equal(run.artifacts?.verification.length, 2);
	assert.match(run.artifacts!.verification[0].output, /verified/);
});

test("real shared turn budget spans successive workers", { timeout: 20000 }, async () => {
	const scheduler = new Scheduler(undefined, { maxTurns: 1 });
	const runner = runnerFor(scheduler);
	const first = await runner.run(defaults, worker, "one", { timeoutSeconds: 10 });
	assert.equal(first.status, "ok", `${first.errorMessage}\n${first.stderr}`);
	const before = calls();
	const second = await runner.run(defaults, worker, "two", { timeoutSeconds: 10 });
	assert.equal(second.status, "budget");
	assert.equal(calls(), before);
	assert.equal((await scheduler.snapshot()).cost, 0.01);
});

test("real observed cost ceiling stops a tool loop", { timeout: 15000 }, async () => {
	const before = calls();
	const run = await runnerFor().run(defaults, worker, "LOOP_TOOLS", { maxCost: 0.01, timeoutSeconds: 10 });
	assert.equal(run.status, "budget", `${run.errorMessage}\n${run.stderr}`);
	assert.equal(calls() - before, 1);
});

test("real pi streaming resets the watchdog while a silent tool hits the stall limit", { timeout: 15000 }, async () => {
	const runner = runnerFor(undefined, { stallTimeoutMs: 500 });
	const streaming = await runner.run(defaults, worker, "STREAM_PROGRESS");
	assert.equal(streaming.status, "ok", `${streaming.errorMessage}\n${streaming.stderr}`);
	assert.equal(streaming.usage.cost, 0.01);
	const stalled = await runner.run(defaults, worker, "SLOW_CHILD");
	assert.equal(stalled.status, "timeout", `${stalled.errorMessage}\n${stalled.stderr}`);
	assert.match(stalled.errorMessage!, /stall timeout/);
	assert.equal(stalled.usage.cost, 0.01);
	assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
});

test(
	"real nested delegation uses the default launcher, yields the parent slot, and bills descendants once",
	{ timeout: 30000 },
	async () => {
		const extDir = installFixtureExtensions();
		const runner = new Runner({ scheduler: new Scheduler(undefined, { concurrency: 1 }), killGraceMs: 1000 });
		try {
			const run = await runner.run(defaults, { ...worker, extensions: true, tools: ["subagent"] }, "DELEGATE", {
				timeoutSeconds: 20,
				maxTurns: 3,
			});
			assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
			const result = run.messages.find((m) => m.role === "toolResult" && m.toolName === "subagent");
			assert.ok(result && result.role === "toolResult");
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.equal(run.usage.cost, 0.03);
			const tree = await runner.scheduler.snapshot();
			assert.equal(tree.runs, 2);
			assert.equal(tree.turns, 3);
			assert.equal(tree.cost, 0.03);
		} finally {
			fs.rmSync(extDir, { recursive: true, force: true });
		}
	},
);

test("child shutdown reports uncollected background usage before closing RPC", { timeout: 30000 }, async () => {
	const extDir = installFixtureExtensions();
	const runner = new Runner({ scheduler: new Scheduler(undefined, { concurrency: 2 }), killGraceMs: 5000 });
	try {
		const run = await runner.run(
			defaults,
			{ ...worker, extensions: true, tools: ["subagent"] },
			"BACKGROUND_DELEGATE",
			{ timeoutSeconds: 20, maxTurns: 3 },
		);
		assert.equal(run.status, "ok", `${run.errorMessage}\n${run.stderr}`);
		assert.equal(run.usage.cost, 0.03);
		assert.equal((await runner.scheduler.snapshot()).cost, 0.03);
		const session = fs.readFileSync(run.sessionFile!, "utf8");
		assert.match(session, /subagents-ex-accounting/);
	} finally {
		fs.rmSync(extDir, { recursive: true, force: true });
	}
});

test(
	"tree-budget cancellation retains descendant charges even before their tool result returns",
	{ timeout: 30000 },
	async () => {
		const extDir = installFixtureExtensions();
		const runner = new Runner({
			scheduler: new Scheduler(undefined, { concurrency: 1, maxCost: 0.015 }),
			killGraceMs: 5000,
		});
		try {
			const run = await runner.run(
				defaults,
				{ ...worker, extensions: true, tools: ["subagent"] },
				"FOREGROUND_SLOW_DELEGATE",
				{ timeoutSeconds: 20, maxTurns: 3 },
			);
			assert.equal(run.status, "budget", `${run.errorMessage}\n${run.stderr}`);
			assert.equal(run.usage.cost, 0.02);
			assert.equal(run.usage.input, 20);
			assert.equal(run.attemptHistory?.[0].usage.cost, 0.02);
			assert.equal((await runner.scheduler.snapshot()).cost, 0.02);
		} finally {
			fs.rmSync(extDir, { recursive: true, force: true });
		}
	},
);
