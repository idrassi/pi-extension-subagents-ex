/** Small opt-in comparison corpus. No provider requests without an explicit --model. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		model: { type: "string" },
		stock: { type: "string" },
		out: { type: "string" },
		repeats: { type: "string", default: "1" },
		variants: { type: "string", default: "single,stock,extended" },
		timeout: { type: "string", default: "120" },
		"max-cost": { type: "string", default: "1" },
		"provider-extension": { type: "string", multiple: true },
		list: { type: "boolean" },
		"check-fixtures": { type: "boolean" },
	},
});
const corpus = fileURLToPath(new URL("../benchmarks/cases/", import.meta.url));
const cases = fs
	.readdirSync(corpus)
	.sort()
	.map(
		(name) =>
			({
				...JSON.parse(fs.readFileSync(path.join(corpus, name, "task.json"), "utf8")),
				dir: path.join(corpus, name),
			}) as { id: string; task: string; dir: string },
	);
const execute = promisify(execFile);
async function check(dir: string, cwd: string) {
	try {
		const result = await execute(process.execPath, [path.join(dir, "check.mjs")], {
			cwd,
			env: { ...process.env, EVAL_WORKSPACE: cwd },
			timeout: 15000,
		});
		return { passed: true, output: result.stdout + result.stderr };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message: string };
		return { passed: false, output: e.stdout || e.stderr || e.message };
	}
}

if (values.list || (!values.model && !values["check-fixtures"])) {
	console.log(
		JSON.stringify(
			cases.map(({ id, task }) => ({ id, task })),
			null,
			2,
		),
	);
	console.log(
		"Use --check-fixtures for offline validation, or --model provider/id to run paid comparisons. See benchmarks/README.md.",
	);
} else if (values["check-fixtures"]) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-eval-fixtures-"));
	try {
		for (const task of cases) {
			fs.copyFileSync(path.join(task.dir, "initial.mjs"), path.join(cwd, "lib.mjs"));
			if ((await check(task.dir, cwd)).passed)
				throw new Error(`${task.id}: initial implementation unexpectedly passes`);
			fs.copyFileSync(path.join(task.dir, "solution.mjs"), path.join(cwd, "lib.mjs"));
			const verified = await check(task.dir, cwd);
			if (!verified.passed) throw new Error(`${task.id}: reference solution failed: ${verified.output}`);
			console.log(`${task.id}: initial fails; reference passes`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
} else {
	const repeats = Number(values.repeats),
		timeout = Number(values.timeout),
		maxCost = Number(values["max-cost"]);
	if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("repeats must be 1–20");
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600)
		throw new Error("timeout must be >0 and <=3600 seconds");
	if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 100)
		throw new Error("max-cost must be >0 and <=100 USD per trial");
	const variants = values.variants!.split(",");
	if (variants.some((v) => !["single", "stock", "extended"].includes(v)))
		throw new Error("variants: single,stock,extended");
	if (variants.includes("stock") && !values.stock)
		throw new Error("Pass --stock /path/to/pi/examples/extensions/subagent/index.ts, or --variants single,extended");
	const out = path.resolve(values.out ?? `evaluation-${Date.now()}`);
	fs.mkdirSync(out, { recursive: true, mode: 0o700 });
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const config = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-eval-config-"));
	process.env.PI_CODING_AGENT_DIR = config;
	for (const key of ["TREE_ID", "LEASE_ID", "PARENT_PID", "DEPTH"]) delete process.env[`PI_SUBAGENTS_EX_${key}`];
	try {
		// Credentials are copied locally into a private temporary directory, never into results.
		for (const name of ["auth.json", "models.json"])
			if (fs.existsSync(path.join(previousAgentDir, name)))
				fs.copyFileSync(path.join(previousAgentDir, name), path.join(config, name));
		fs.writeFileSync(
			path.join(config, "settings.json"),
			JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }),
		);
		fs.mkdirSync(path.join(config, "agents"));
		fs.writeFileSync(
			path.join(config, "agents/worker.md"),
			`---\nname: worker\ndescription: Implement a scoped coding task\nmodel: ${JSON.stringify(values.model)}\ntimeout: ${timeout}\nmaxTurns: 20\nskills: false\ncontextFiles: false\n---\nImplement the requested change. Verify it before returning.\n`,
		);
		const { Runner } = await import("../src/runner.ts");
		const { Scheduler } = await import("../src/scheduler.ts");
		const { git } = await import("../src/worktree.ts");
		const cli = path.join(
			path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
			"bundle/cli.js",
		);
		const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
		const rows: Array<{
			variant: string;
			task: string;
			repeat: number;
			success: boolean;
			latencyMs: number;
			cost: number;
			tokens: number;
			status: string;
		}> = [];
		const checkedGit = async (args: string[], cwd: string) => {
			const r = await git(args, cwd);
			if (r.code) throw new Error(r.stderr);
			return r.stdout;
		};
		for (let repeat = 1; repeat <= repeats; repeat++)
			for (const task of cases)
				for (const variant of variants) {
					const name = `${task.id}-${variant}-${repeat}`;
					const cwd = path.join(out, name);
					fs.mkdirSync(cwd);
					fs.copyFileSync(path.join(task.dir, "initial.mjs"), path.join(cwd, "lib.mjs"));
					await checkedGit(["init", "--initial-branch=main"], cwd);
					await checkedGit(["add", "."], cwd);
					await checkedGit(
						["-c", "user.name=Evaluation", "-c", "user.email=evaluation@example.invalid", "commit", "-m", "fixture"],
						cwd,
					);
					const extensions = [
						...(values["provider-extension"] ?? []).map((f) => path.resolve(f)),
						...(variant === "extended" ? [extension] : variant === "stock" ? [path.resolve(values.stock!)] : []),
					];
					const extDir = path.join(config, "extensions");
					fs.rmSync(extDir, { recursive: true, force: true });
					fs.mkdirSync(extDir);
					// Descendants inherit only the selected comparison variant and provider adapters.
					for (const [i, ext] of extensions.entries())
						fs.writeFileSync(path.join(extDir, `${i}.ts`), `export { default } from ${JSON.stringify(ext)};\n`);
					const runner = new Runner({
						scheduler: new Scheduler(undefined, { concurrency: 4, maxRuns: 32, maxTurns: 100, maxCost }),
						invocation: { command: process.execPath, prefix: [cli, ...extensions.flatMap((f) => ["--extension", f])] },
					});
					const started = Date.now();
					const run = await runner.run(
						{ cwd, depth: 0 },
						{
							name: variant,
							description: "Evaluation dispatcher",
							source: "user",
							filePath: "evaluation",
							systemPrompt: "Complete the requested repository task and verify it. Only lib.mjs may change.",
							model: values.model!,
							skills: false,
							contextFiles: false,
							extensions: false,
						},
						`${task.task}\n${variant === "single" ? "Implement this directly." : "Use the subagent tool to delegate implementation to worker. Review its changes before finishing."}`,
						{ timeoutSeconds: timeout, maxTurns: 20, maxCost },
					);
					const latencyMs = Date.now() - started;
					const verification = await check(task.dir, cwd);
					const diffCheck = await git(["diff", "--check", "HEAD"], cwd);
					const changed = (await checkedGit(["diff", "--name-only", "HEAD"], cwd)).trim().split("\n").filter(Boolean);
					const untracked = (await checkedGit(["ls-files", "--others", "--exclude-standard"], cwd)).trim();
					const success =
						run.status === "ok" &&
						verification.passed &&
						diffCheck.code === 0 &&
						changed.every((f) => f === "lib.mjs") &&
						!untracked;
					rows.push({
						variant,
						task: task.id,
						repeat,
						success: Boolean(success),
						latencyMs,
						cost: run.usage.cost,
						tokens: run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite,
						status: run.status,
					});
					fs.writeFileSync(
						path.join(out, `${name}.json`),
						JSON.stringify({ model: values.model, run, verification, diffCheck, changed, untracked }, null, 2),
						{ mode: 0o600 },
					);
					console.log(
						`${name}: ${success ? "PASS" : "FAIL"} ${(latencyMs / 1000).toFixed(1)}s $${run.usage.cost.toFixed(4)}`,
					);
				}
		const summary = variants.map((variant) => {
			const trials = rows.filter((r) => r.variant === variant);
			const avg = (key: "cost" | "latencyMs" | "tokens") => trials.reduce((n, r) => n + r[key], 0) / trials.length;
			return {
				variant,
				trials: trials.length,
				successes: trials.filter((r) => r.success).length,
				successRate: trials.filter((r) => r.success).length / trials.length,
				meanCost: avg("cost"),
				meanLatencyMs: avg("latencyMs"),
				meanTokens: avg("tokens"),
			};
		});
		fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ model: values.model, rows, summary }, null, 2), {
			mode: 0o600,
		});
		fs.cpSync(path.join(config, "subagents-ex"), path.join(out, "state"), { recursive: true });
		console.table(summary);
	} finally {
		fs.rmSync(config, { recursive: true, force: true });
	}
}
