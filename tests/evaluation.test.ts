import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	git, checkedGit, checkIntegrity, initializeTrial, loadCases, materializeCase, checkAcceptance,
	normalizeTrialUsage, trialBudgets, corpusDigest, packageVersion,
} from "../scripts/evaluation.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const corpus = path.join(root, "benchmarks/cases");
const cases = loadCases(corpus);
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "evaluation-test-"));
async function repo(t: { after: (fn: () => void) => void }) {
	const cwd = temp();
	t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 1;\n");
	fs.writeFileSync(path.join(cwd, "protected.txt"), "do not edit\n");
	fs.writeFileSync(path.join(cwd, ".gitignore"), "*.ignored\n");
	return { cwd, baseline: await initializeTrial(cwd) };
}
const commit = async (cwd: string) => {
	await checkedGit(["add", "--all"], cwd);
	await checkedGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", "worker"], cwd);
};

test("immutable baseline includes committed worker changes and rejects committed forbidden files", async (t) => {
	const { cwd, baseline } = await repo(t);
	assert.ok(Object.isFrozen(baseline));
	assert.ok(Object.isFrozen(baseline.files));
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;\n");
	await commit(cwd);
	assert.equal((await checkIntegrity(cwd, baseline, ["lib.mjs"])).passed, true);
	fs.writeFileSync(path.join(cwd, "protected.txt"), "forbidden\n");
	await commit(cwd);
	const result = await checkIntegrity(cwd, baseline, ["lib.mjs"]);
	assert.equal(result.passed, false);
	assert.deepEqual(result.forbidden, ["protected.txt"]);
	// A later commit reverting the forbidden edit cannot erase its history.
	fs.writeFileSync(path.join(cwd, "protected.txt"), "do not edit\n");
	await commit(cwd);
	assert.deepEqual((await checkIntegrity(cwd, baseline, ["lib.mjs"])).forbidden, ["protected.txt"]);
});

test("history rewrites and replacement refs cannot redefine the initial baseline", async (t) => {
	const { cwd, baseline } = await repo(t);
	await checkedGit(["checkout", "--orphan", "rewritten"], cwd);
	fs.writeFileSync(path.join(cwd, "protected.txt"), "rewritten history\n");
	await commit(cwd);
	const rewritten = (await checkedGit(["rev-parse", "HEAD"], cwd)).trim();
	await checkedGit(["replace", baseline.initialCommit, rewritten], cwd);
	const result = await checkIntegrity(cwd, baseline, ["lib.mjs"]);
	assert.equal(result.passed, false);
	assert.ok(result.errors.some((e) => e.includes("history")));
	assert.ok(result.forbidden.includes("protected.txt"));
	assert.equal(result.initialCommit, baseline.initialCommit);
});

test("scope sees staged-only, deleted, untracked, ignored and index-hidden changes with NUL filenames", async (t) => {
	const { cwd, baseline } = await repo(t);
	fs.writeFileSync(path.join(cwd, "protected.txt"), "staged-only\n");
	await checkedGit(["add", "protected.txt"], cwd);
	fs.writeFileSync(path.join(cwd, "protected.txt"), "do not edit\n");
	const odd = "a\nquoted\t\"file.ignored";
	fs.writeFileSync(path.join(cwd, odd), "ignored but forbidden\n");
	fs.writeFileSync(path.join(cwd, "plain\nfile"), "untracked\n");
	fs.unlinkSync(path.join(cwd, ".gitignore"));
	let result = await checkIntegrity(cwd, baseline, ["lib.mjs"]);
	assert.equal(result.passed, false);
	assert.deepEqual(result.forbidden, [".gitignore", odd, "plain\nfile", "protected.txt"].sort());
	await checkedGit(["reset", "--hard", baseline.initialCommit], cwd);
	fs.rmSync(path.join(cwd, odd)); fs.rmSync(path.join(cwd, "plain\nfile"));
	await checkedGit(["update-index", "--assume-unchanged", "protected.txt"], cwd);
	fs.writeFileSync(path.join(cwd, "protected.txt"), "invisible to ordinary diff\n");
	result = await checkIntegrity(cwd, baseline, ["lib.mjs"]);
	assert.deepEqual(result.forbidden, ["protected.txt"]);
});

test("committed whitespace fails even with clean mutable HEAD, including reverted whitespace", async (t) => {
	const { cwd, baseline } = await repo(t);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;  \n");
	await commit(cwd);
	const result = await checkIntegrity(cwd, baseline, ["lib.mjs"]);
	assert.equal(result.passed, false);
	assert.ok(result.whitespace.some((check) => check.code !== 0));
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;\n");
	await commit(cwd);
	assert.equal((await checkIntegrity(cwd, baseline, ["lib.mjs"])).passed, false);
});

test("private whitespace index ignores worker index flags and checks newly added allowed files", async (t) => {
	const { cwd, baseline } = await repo(t);
	await checkedGit(["update-index", "--skip-worktree", "lib.mjs"], cwd);
	await checkedGit(["config", "core.whitespace", "-blank-at-eol"], cwd);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;  \n");
	assert.equal((await checkIntegrity(cwd, baseline, ["lib.mjs"])).passed, false);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 1;\n");
	fs.writeFileSync(path.join(cwd, "new.mjs"), "export {};  \n");
	assert.equal((await checkIntegrity(cwd, baseline, ["lib.mjs", "new.mjs"])).passed, false);
});

for (const state of ["worktree", "staged-only", "new", "committed", "reverted"] as const) {
	test(`worker info attributes cannot mask ${state} whitespace or change worker state`, async (t) => {
		const { cwd, baseline } = await repo(t);
		const attributes = path.join(cwd, ".git/info/attributes");
		fs.writeFileSync(attributes, "* -whitespace\n");
		await checkedGit(["config", "core.attributesFile", attributes], cwd);
		const name = state === "new" ? "new.mjs" : "lib.mjs";
		fs.writeFileSync(path.join(cwd, name), "export const value = 2;  \n");
		if (state === "worktree") await checkedGit(["update-index", "--skip-worktree", "lib.mjs"], cwd);
		if (state === "staged-only") {
			await checkedGit(["add", "lib.mjs"], cwd);
			fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 1;\n");
		}
		if (state === "committed" || state === "reverted") await commit(cwd);
		if (state === "reverted") {
			fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 1;\n");
			await commit(cwd);
		}
		const gitState = () => fs.readdirSync(path.join(cwd, ".git"), { recursive: true }).map(String).sort()
			.filter((file) => fs.lstatSync(path.join(cwd, ".git", file)).isFile())
			.map((file) => [file, fs.readFileSync(path.join(cwd, ".git", file))]);
		const before = gitState();
		const result = await checkIntegrity(cwd, baseline, ["lib.mjs", "new.mjs"]);
		assert.deepEqual(gitState(), before, "even the worker object store must remain unchanged");
		assert.equal(result.passed, false, `${state} whitespace must fail despite -whitespace attributes`);
		assert.deepEqual(result.errors, [], "the failure must be a real whitespace finding");
		assert.deepEqual(result.forbidden, []);
		assert.ok(result.whitespace.some((check) => check.code !== 0 && check.stdout.includes("trailing whitespace")));
	});
}

test("trusted attribute checks preserve split worker indexes and catch staged-only whitespace", async (t) => {
	const { cwd, baseline } = await repo(t);
	fs.writeFileSync(path.join(cwd, ".git/info/attributes"), "* -whitespace\n");
	await checkedGit(["update-index", "--split-index"], cwd);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;  \n");
	await checkedGit(["add", "lib.mjs"], cwd);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 1;\n");
	const shared = path.resolve(cwd, (await checkedGit(["rev-parse", "--shared-index-path"], cwd)).trim());
	const index = path.join(cwd, ".git/index");
	const before = [fs.readFileSync(index), fs.readFileSync(shared)];
	const result = await checkIntegrity(cwd, baseline, ["lib.mjs"]);
	assert.deepEqual([fs.readFileSync(index), fs.readFileSync(shared)], before);
	assert.equal(result.passed, false);
	assert.deepEqual(result.errors, []);
	assert.ok(result.whitespace.some((check) => check.code !== 0 && check.stdout.includes("trailing whitespace")));
});

for (const redirection of ["index/objects", "repository/config"] as const) {
	test(`inherited Git ${redirection} redirection cannot touch an external repository`, async (t) => {
		const { cwd: external } = await repo(t);
		fs.writeFileSync(path.join(external, "lib.mjs"), "user changes: do not stage\n");
		const trial = temp(); t.after(() => fs.rmSync(trial, { recursive: true, force: true }));
		fs.writeFileSync(path.join(trial, "lib.mjs"), "export const value = 1;\n");
		const gitDir = path.join(external, ".git");
		const state = () => fs.readdirSync(gitDir, { recursive: true }).map(String).sort()
			.filter((file) => fs.lstatSync(path.join(gitDir, file)).isFile())
			.map((file) => [file, fs.readFileSync(path.join(gitDir, file))]);
		const config = path.join(external, "redirect-config");
		fs.writeFileSync(config, `[core]\nworktree = ${external}\n`);
		const before = state();
		const redirected = redirection === "index/objects"
			? { GIT_INDEX_FILE: path.join(gitDir, "index"), GIT_OBJECT_DIRECTORY: path.join(gitDir, "objects") }
			: { GIT_DIR: gitDir, GIT_COMMON_DIR: gitDir, GIT_WORK_TREE: external,
				GIT_CONFIG: config, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: "0",
				GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: external,
				GIT_CONFIG_PARAMETERS: `'core.worktree=${external}'` };
		const source = `import * as fs from 'node:fs';
			import { initializeTrial, checkIntegrity } from ${JSON.stringify(new URL("../scripts/evaluation.ts", import.meta.url).href)};
			try {
				const baseline = await initializeTrial(${JSON.stringify(trial)});
				const clean = await checkIntegrity(${JSON.stringify(trial)}, baseline, ['lib.mjs']);
				fs.writeFileSync(${JSON.stringify(path.join(trial, "lib.mjs"))}, 'export const value = 2;  \\n');
				const dirty = await checkIntegrity(${JSON.stringify(trial)}, baseline, ['lib.mjs']);
				console.log(JSON.stringify({ ok: true, clean, dirty }));
			} catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }`;
		const child = await execute(process.execPath, ["--input-type=module", "-e", source], {
			cwd: root, env: { ...process.env, ...redirected }, timeout: 10000,
		});
		assert.deepEqual(state(), before, "external indexes, objects, configuration and refs must not change");
		assert.equal(fs.readFileSync(path.join(external, "lib.mjs"), "utf8"), "user changes: do not stage\n");
		const result = JSON.parse(child.stdout);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal(result.clean.passed, true, JSON.stringify(result.clean));
		assert.equal(result.dirty.passed, false);
		assert.deepEqual(result.dirty.errors, []);
		assert.ok(result.dirty.whitespace.some((check: { code: number }) => check.code !== 0));
	});
}

test("Git subprocesses have a finite timeout even if the executable ignores SIGTERM", { timeout: 22000, skip: process.platform === "win32" }, async (t) => {
	const cwd = temp(); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	fs.writeFileSync(path.join(cwd, "git"), `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 17000);\n`, { mode: 0o700 });
	const result = await git(["--version"], cwd, { PATH: `${cwd}${path.delimiter}${process.env.PATH}` });
	assert.notEqual(result.code, 0, "a hung Git process must fail rather than eventually succeed");
});

test("trusted whitespace policy accepts CRLF but still rejects spaces before CRLF", async (t) => {
	const { cwd, baseline } = await repo(t);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;\r\n");
	assert.equal((await checkIntegrity(cwd, baseline, ["lib.mjs"])).passed, true);
	fs.writeFileSync(path.join(cwd, "lib.mjs"), "export const value = 2;  \r\n");
	assert.equal((await checkIntegrity(cwd, baseline, ["lib.mjs"])).passed, false);
});

const stats = (n: number) => ({ input: n * 100, output: n * 10, cacheRead: n * 20, cacheWrite: n * 5, cost: n, contextTokens: n * 135, turns: 1 });
const sdk = (n: number) => ({ input: n * 100, output: n * 10, cacheRead: n * 20, cacheWrite: n * 5, cost: { total: n }, totalTokens: n * 135 });
const assistant = (n: number, stopReason = "stop") => ({ role: "assistant", usage: sdk(n), stopReason, content: [] });
const stockRun = (n: number, messages: unknown[] = [assistant(n)]) => ({ agent: "worker", agentSource: "user", task: "fix", messages, usage: stats(n), exitCode: 0 });
const tool = (details: unknown, n?: number, toolName = "subagent", toolCallId = "call") => ({ role: "toolResult", toolCallId, toolName, details, ...(n === undefined ? {} : { usage: sdk(n) }) });
const totalCost = (run: Parameters<typeof normalizeTrialUsage>[0], variant = "stock") => normalizeTrialUsage(run, variant).normalized.cost;

test("stock details.results single/parallel/chain and recursively nested charges are added exactly once", () => {
	for (const mode of ["single", "parallel", "chain"]) {
		const children = mode === "single" ? [stockRun(2)] : [stockRun(2), stockRun(3)];
		assert.equal(totalCost({ usage: stats(1), messages: [assistant(1), tool({ mode, results: children })] }), mode === "single" ? 3 : 6);
	}
	const child = stockRun(2, [assistant(2), tool({ results: [stockRun(3)] })]);
	assert.equal(totalCost({ usage: stats(1), messages: [assistant(1), tool({ results: [child] })] }), 6);
	const duplicate = { results: [stockRun(2)] };
	const details = { first: duplicate, nestedCalls: [{ result: { details: structuredClone(duplicate) } }] };
	assert.equal(totalCost({ usage: stats(1), messages: [assistant(1), tool(details)] }), 3);
});

test("stock wrappers preserve unrelated SDK charges; explicit SDK coverage and totals do not double bill", () => {
	const details = { results: [stockRun(2)] };
	// This wrapper has its own direct fee, not a stock aggregate SDK result.
	assert.equal(totalCost({ usage: stats(5), messages: [assistant(1), tool(details, 4, "wrapper")] }), 7);
	assert.equal(totalCost({ usage: stats(3), messages: [assistant(1), tool(details, 2)] }), 3);
	const wrapper = { task: { result: { content: [], details, usage: sdk(2) } } };
	assert.equal(totalCost({ usage: stats(7), messages: [assistant(1), tool(wrapper, 6, "wrapper")] }), 7);
	// A reconciled SDK session total already includes the descendant charge.
	assert.equal(totalCost({ usage: stats(3), messages: [assistant(1), tool(details)] }), 3);
	assert.equal(totalCost({ usage: stats(9), messages: [assistant(1), tool(details)] }), 9);
});

test("SDK coverage of cloned descendant evidence is independent of wrapper property order", () => {
	const echo = { results: [stockRun(2)] };
	const covered = { result: { content: [], details: structuredClone(echo), usage: sdk(2) } };
	for (const details of [{ echo, covered }, { covered, echo }]) {
		const result = normalizeTrialUsage({ usage: stats(7), messages: [assistant(1), tool(details, 6, "wrapper")] }, "stock");
		assert.equal(result.normalized.cost, 7, "the wrapper's unrelated fee4 and covered child2 are already in SDK6");
		assert.equal(result.addedStock.cost, 0);
		assert.equal(result.complete, true, result.warnings.join("; "));
		assert.equal(totalCost({ usage: stats(5), messages: [assistant(1), tool(echo, 4, "wrapper")] }), 7);
	}
});

test("nestedCalls metadata without results or SDK coverage proves missing stock evidence", () => {
	const wrapper = { ...tool({}, undefined, "wrapper"), nestedCalls: { calls: [{ id: "call/1", name: "subagent", status: "ok" }], complete: true } };
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), wrapper] }, "stock");
	assert.equal(result.normalized.cost, 1, "metadata itself is not a usage charge");
	assert.equal(result.complete, false, "a completed call record does not prove complete billing evidence");
	assert.ok(result.warnings.some((warning) => /nestedCalls|missing.*evidence/i.test(warning)));
});

test("unmatched direct stock calls remain incomplete after an aborted trial", () => {
	const pending = { ...assistant(1), content: [{ type: "toolCall", id: "pending", name: "subagent", arguments: {} }] };
	const incomplete = normalizeTrialUsage({ usage: stats(1), messages: [pending] }, "stock");
	assert.equal(incomplete.normalized.cost, 1);
	assert.equal(incomplete.complete, false);
	const result = { ...tool({ results: [stockRun(2)] }), toolCallId: "pending" };
	assert.equal(normalizeTrialUsage({ usage: stats(1), messages: [pending, result] }, "stock").complete, true);
});

test("partial nested call results cannot make missing stock calls authoritative", () => {
	const nestedCalls = { calls: [{ id: "wrap/1", name: "subagent" }, { id: "wrap/2", name: "subagent" }], complete: true };
	const outcome = (id: string, cost: number) => ({ toolCall: { id, name: "subagent", arguments: {} },
		result: { details: { results: [stockRun(cost)] }, usage: sdk(cost) } });
	const partial = { ...tool({ first: outcome("wrap/1", 2) }, 2, "wrapper"), nestedCalls };
	assert.equal(normalizeTrialUsage({ usage: stats(3), messages: [assistant(1), partial] }, "stock").complete, false);
	const complete = { ...tool({ first: outcome("wrap/1", 2), second: outcome("wrap/2", 3) }, 5, "wrapper"), nestedCalls };
	const known = normalizeTrialUsage({ usage: stats(6), messages: [assistant(1), complete] }, "stock");
	assert.equal(known.normalized.cost, 6);
	assert.equal(known.complete, true, known.warnings.join("; "));
});

test("nestedCalls arguments are metadata, not reconstructable billing results", () => {
	const wrapper = { ...tool({}, undefined, "wrapper"), nestedCalls: { calls: [
		{ id: "call/1", name: "subagent", status: "ok", arguments: { results: [stockRun(20)] } },
	], complete: true } };
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), wrapper] }, "stock");
	assert.equal(result.normalized.cost, 1, "result-like arguments are not evidence of incurred usage");
	assert.equal(result.complete, false);
});

test("a foreign treeId alone cannot exempt a known descendant charge", () => {
	const child = { ...stockRun(2), id: "foreign-run", treeId: "foreign-tree" };
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [child] })] }, "stock");
	assert.equal(result.normalized.cost, 3);
	assert.equal(result.complete, true, result.warnings.join("; "));
	const covered = normalizeTrialUsage({ usage: stats(3), messages: [assistant(1), tool({ results: [child] }, 2)] }, "stock");
	assert.equal(covered.normalized.cost, 3);
	assert.equal(covered.complete, true, covered.warnings.join("; "));
});

test("child SDK cost.total usage is charged and nested SDK/descendant overlap is incomplete", () => {
	const known = { ...stockRun(2), usage: sdk(2) };
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [known] })] }, "stock");
	assert.equal(result.normalized.cost, 3);
	assert.equal(result.complete, true, result.warnings.join("; "));
	const nestedMessages = [assistant(2), tool({ results: [stockRun(3)] })];
	const direct = { ...stockRun(2, nestedMessages), usage: sdk(2) };
	const reconstructed = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [direct] })] }, "stock");
	assert.equal(reconstructed.normalized.cost, 6);
	assert.equal(reconstructed.complete, true, reconstructed.warnings.join("; "));
	for (const childUsage of [sdk(5), stats(5), sdk(7)]) {
		const child = { ...stockRun(5, nestedMessages), usage: childUsage };
		const ambiguous = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [child] })] }, "stock");
		assert.equal(ambiguous.normalized.cost, 1 + (typeof childUsage.cost === "number" ? childUsage.cost : childUsage.cost.total));
		assert.equal(ambiguous.complete, false, "native totals vs direct fees cannot be resolved from a child aggregate alone");
		assert.ok(ambiguous.warnings.some((warning) => /Ambiguous SDK.*descendant/i.test(warning)));
	}
});

test("nested numeric child aggregates cannot claim authoritative cost when native totals may overlap descendants", () => {
	const child = stockRun(5, [assistant(2), tool({ results: [stockRun(3)] })]);
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [child] })] }, "stock");
	assert.equal(result.normalized.cost, 6, "retain the known floor without adding a possibly duplicated charge");
	assert.equal(result.complete, false);
	assert.ok(result.warnings.some((warning) => /Ambiguous SDK.*child.*descendant/i.test(warning)));
});

test("SDK-shaped children with missing transcripts keep known charges but remain incomplete", () => {
	const child = { agent: "worker", usage: sdk(2) };
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [child] })] }, "stock");
	assert.equal(result.normalized.cost, 3);
	assert.equal(result.complete, false);
});

test("partial SDK coverage and already-covered managed DTOs retain exact known charges", () => {
	const partial = normalizeTrialUsage({ usage: stats(2), messages: [assistant(1), tool({ results: [stockRun(2)] }, 1)] }, "stock");
	assert.equal(partial.normalized.cost, 3);
	assert.equal(partial.complete, true, partial.warnings.join("; "));
	const dto = { agent: "worker", id: "managed", treeId: "tree", usage: stats(2) };
	const covered = normalizeTrialUsage({ usage: stats(3), messages: [assistant(1), tool({ results: [dto] }, 2)] }, "stock");
	assert.equal(covered.normalized.cost, 3);
	assert.equal(covered.complete, true, covered.warnings.join("; "));
	const unknown = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [dto] })] }, "stock");
	assert.equal(unknown.normalized.cost, 3);
	assert.equal(unknown.complete, false);
});

test("nested SDK coverage absent from outer usage cannot erase a known charge", () => {
	const details = { result: { content: [], details: { results: [stockRun(2)] }, usage: sdk(2) } };
	const result = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool(details, undefined, "wrapper")] }, "stock");
	assert.equal(result.normalized.cost, 3);
	assert.equal(result.complete, false);
});

test("attempt aliases, errors, managed extended results and SDK cost.total survive normalization", () => {
	const messages = [assistant(1, "error"), tool({ results: [{ ...stockRun(2), exitCode: 1, stopReason: "error" }] })];
	const run = { usage: stats(2), messages, attemptHistory: [{ usage: stats(1), messages }, { usage: stats(1), messages: [assistant(1)] }] };
	assert.equal(totalCost(run), 4, "latest messages must not be added a second time");
	assert.equal(totalCost(run, "extended"), 2);
	assert.equal(totalCost(run, "single"), 2);
	assert.equal(totalCost({ usage: stats(3), messages: [assistant(1), tool({ results: [{ ...stockRun(2), id: "managed", treeId: "tree" }] }, 2)] }), 3);
	const normalized = normalizeTrialUsage({ usage: sdk(2), messages: [assistant(2)] }, "stock");
	assert.equal(normalized.normalized.cost, 2);
	assert.equal(normalized.normalized.input, 200);
	assert.equal(normalized.normalized.cacheWrite, 10);
	assert.throws(() => normalizeTrialUsage({ usage: { cost: NaN } }, "stock"), /Invalid reported/);
});

test("missing stock usage and ambiguous SDK remainders are surfaced, never silently free", () => {
	const missing = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool({ results: [{ agent: "worker", messages: [] }] })] }, "stock");
	assert.equal(missing.complete, false);
	assert.ok(missing.warnings.some((warning) => warning.includes("missing")));
	const unknown = normalizeTrialUsage({ usage: stats(1), messages: [assistant(1), tool(undefined)] }, "stock");
	assert.equal(unknown.complete, false);
	const ambiguous = normalizeTrialUsage({ usage: stats(3), messages: [assistant(1), tool({ results: [stockRun(2)] })] }, "stock");
	assert.equal(ambiguous.normalized.cost, 3);
	assert.equal(ambiguous.complete, false);
	assert.ok(ambiguous.warnings.some((warning) => warning.includes("Ambiguous SDK")));
});

test("root budgets match while manifest distinguishes descendant enforcement", () => {
	const budgets = ["single", "stock", "extended"].map((v) => trialBudgets(v, 120, 1));
	assert.deepEqual(budgets[0].root, budgets[1].root);
	assert.deepEqual(budgets[1].root, budgets[2].root);
	assert.match(budgets[1].descendants.enforcement, /no shared descendant/);
	assert.equal(budgets[2].descendants.enforcement, "shared-tree");
	assert.equal(corpusDigest(corpus), corpusDigest(corpus));
	assert.match(packageVersion(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "@earendil-works/pi-coding-agent"), /^\d+\./);
});

test("external acceptance rejects known bad first-item and permanent async rejection mutants", async (t) => {
	const cwd = temp(); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
	for (const [id, fixture] of [["map-limit", "evaluation-map-first.mjs"], ["memoize-async", "evaluation-memo-reject-cache.mjs"]]) {
		const task = cases.find((task) => task.id === id)!;
		fs.copyFileSync(path.join(root, "tests/fixtures", fixture), path.join(cwd, "lib.mjs"));
		assert.equal((await checkAcceptance(task, cwd)).passed, false, `${id} mutant must fail`);
	}
});

test("fresh multi-file initial/reference lifecycle uses external acceptance and exact per-task scope", async (t) => {
	const task = cases.find((task) => task.allowlist.length > 1);
	assert.ok(task, "corpus must contain a multi-file repository task");
	const tmp = temp(); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const initial = path.join(tmp, "initial"), reference = path.join(tmp, "reference");
	materializeCase(task, initial); materializeCase(task, reference, true);
	assert.equal(fs.existsSync(path.join(initial, "check.mjs")), false, "private acceptance is outside the checkout");
	assert.equal((await checkAcceptance(task, initial)).passed, false);
	const baseline = await initializeTrial(initial);
	fs.cpSync(reference, initial, { recursive: true });
	await commit(initial);
	const check = await checkAcceptance(task, initial);
	assert.equal(check.passed, true, check.output);
	assert.equal((await checkIntegrity(initial, baseline, task.allowlist)).passed, true);
	fs.writeFileSync(path.join(initial, "unexpected.mjs"), "export {};\n");
	assert.deepEqual((await checkIntegrity(initial, baseline, task.allowlist)).forbidden, ["unexpected.mjs"]);
	assert.throws(() => materializeCase(task, initial), /not empty/);
});

for (const variants of ["single,single", "extended,single,extended", "", ",", "single,"]) {
	test(`CLI rejects invalid variants ${JSON.stringify(variants)} before paid setup`, async (t) => {
		const cwd = temp(); t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
		// A file at --out safely stops the old implementation before any paid execution.
		const out = path.join(cwd, "output-sentinel");
		fs.writeFileSync(out, "must not change\n");
		await assert.rejects(execute(process.execPath, ["scripts/evaluate.ts", "--model", "offline/not-a-provider", "--variants", variants, "--out", out], {
			cwd: root, env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" }, timeout: 5000,
		}), (error: unknown) => {
			const stderr = (error as { stderr: string }).stderr;
			assert.match(stderr, /variants must be a nonempty, unique list/);
			assert.doesNotMatch(stderr, /EEXIST|provider.*not found/i);
			return true;
		});
		assert.equal(fs.readFileSync(out, "utf8"), "must not change\n");
	});
}

test("CLI --list and --check-fixtures are offline and validate every legacy and repository case", { timeout: 30000 }, async () => {
	const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" };
	const listed = await execute(process.execPath, ["scripts/evaluate.ts", "--list"], { cwd: root, env });
	for (const task of cases) assert.ok(listed.stdout.includes(task.id));
	const checked = await execute(process.execPath, ["scripts/evaluate.ts", "--check-fixtures"], { cwd: root, env, timeout: 25000 });
	for (const task of cases) assert.ok(checked.stdout.includes(`${task.id}: initial fails; reference passes`));
});
