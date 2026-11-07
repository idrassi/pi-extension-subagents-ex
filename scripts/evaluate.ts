/** Small opt-in comparison corpus. No provider requests without an explicit --model. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	loadCases, materializeCase, checkAcceptance, initializeTrial, checkIntegrity, checkedGit,
	normalizeTrialUsage, trialBudgets, corpusDigest, fileIdentity, packageVersion,
} from "./evaluation.ts";

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
const cases = loadCases(corpus);

if (values.list || (!values.model && !values["check-fixtures"])) {
	console.log(
		JSON.stringify(
			cases.map(({ id, task, allowlist }) => ({ id, task, allowlist })),
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
			const initial = path.join(cwd, `${task.id}-initial`), reference = path.join(cwd, `${task.id}-reference`);
			materializeCase(task, initial);
			materializeCase(task, reference, true);
			if ((await checkAcceptance(task, initial)).passed)
				throw new Error(`${task.id}: initial implementation unexpectedly passes`);
			const baseline = await initializeTrial(initial);
			// Exercise the same scoped repository lifecycle as a live trial.
			fs.cpSync(reference, initial, { recursive: true });
			const verified = await checkAcceptance(task, initial);
			const integrity = await checkIntegrity(initial, baseline, task.allowlist);
			if (!verified.passed || !integrity.passed)
				throw new Error(`${task.id}: reference solution failed: ${verified.output}\n${JSON.stringify(integrity)}`);
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
	if (!variants.length || new Set(variants).size !== variants.length || variants.some((v) => !["single", "stock", "extended"].includes(v)))
		throw new Error("variants must be a nonempty, unique list of: single,stock,extended");
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
		const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
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
			accountingComplete: boolean;
		}> = [];
		const evaluatorRoot = fileURLToPath(new URL("../", import.meta.url));
		const metadata = Object.freeze({
			schemaVersion: 2, createdAt: new Date().toISOString(), model: values.model,
			node: process.version, platform: process.platform, arch: process.arch,
			gitVersion: (await checkedGit(["--version"], evaluatorRoot)).trim(),
			piVersion: packageVersion(sdkEntry, "@earendil-works/pi-coding-agent"),
			evaluatorCommit: (await checkedGit(["rev-parse", "HEAD"], evaluatorRoot)).trim(),
			evaluatorDirty: (await checkedGit(["status", "--porcelain", "-z"], evaluatorRoot)).length > 0,
			evaluatorFiles: ["evaluate.ts", "evaluation.ts"].map((f) => fileIdentity(path.join(evaluatorRoot, "scripts", f))),
			corpusSha256: corpusDigest(corpus),
			implementationSha256: corpusDigest(path.join(evaluatorRoot, "src")),
			stock: values.stock ? { ...fileIdentity(path.resolve(values.stock)), treeSha256: corpusDigest(path.dirname(path.resolve(values.stock))) } : null,
			providerExtensions: (values["provider-extension"] ?? []).map((f) => fileIdentity(path.resolve(f))),
			settings: { retry: false, compaction: false, skills: false, contextFiles: false, thinking: "SDK default" },
			modelsConfigSha256: fs.existsSync(path.join(config, "models.json")) ? fileIdentity(path.join(config, "models.json")).sha256 : null,
			usagePolicy: "stock details.results reconstructed once; SDK totals are a floor; extended managed totals unchanged",
		});
		fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(metadata, null, 2), { mode: 0o400, flag: "wx" });
		for (let repeat = 1; repeat <= repeats; repeat++)
			for (const task of cases)
				for (const variant of variants) {
					const name = `${task.id}-${variant}-${repeat}`;
					const cwd = path.join(out, name);
					materializeCase(task, cwd);
					const baseline = await initializeTrial(cwd);
					const budgets = trialBudgets(variant, timeout, maxCost);
					const prompt = `${task.task}\n${variant === "single" ? "Implement this directly." : "Use the subagent tool to delegate implementation to worker. Review its changes before finishing."}`;
					const systemPrompt = `Complete the requested repository task and verify it. Only these exact paths may change: ${task.allowlist.join(", ")}.`;
					const trialManifest = Object.freeze({ ...metadata, name, variant, repeat, task: task.id,
						prompt, systemPrompt, allowlist: task.allowlist, baseline, budgets });
					// Record before spawning; validation retains this object, never a worker-editable HEAD/file.
					fs.writeFileSync(path.join(out, `${name}.manifest.json`), JSON.stringify(trialManifest, null, 2), { mode: 0o400, flag: "wx" });
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
							systemPrompt,
							model: values.model!,
							skills: false,
							contextFiles: false,
							extensions: false,
						},
						prompt,
						budgets.root,
					);
					const latencyMs = Date.now() - started;
					const verification = await checkAcceptance(task, cwd);
					const integrity = await checkIntegrity(cwd, baseline, task.allowlist);
					const accounting = normalizeTrialUsage(run, variant);
					const measured = accounting.normalized;
					const success = run.status === "ok" && verification.passed && integrity.passed;
					rows.push({
						variant,
						task: task.id,
						repeat,
						success: Boolean(success),
						latencyMs,
						cost: measured.cost,
						tokens: measured.input + measured.output + measured.cacheRead + measured.cacheWrite,
						status: run.status,
						accountingComplete: accounting.complete,
					});
					for (const warning of accounting.warnings) console.warn(`${name}: USAGE INCOMPLETE: ${warning}`);
					fs.writeFileSync(
						path.join(out, `${name}.json`),
						JSON.stringify({ manifest: trialManifest, run, accounting, verification, integrity }, null, 2),
						{ mode: 0o600 },
					);
					console.log(
						`${name}: ${success ? "PASS" : "FAIL"} ${(latencyMs / 1000).toFixed(1)}s $${measured.cost.toFixed(4)}`,
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
				usageIncompleteTrials: trials.filter((r) => !r.accountingComplete).length,
				meanCost: trials.every((r) => r.accountingComplete) ? avg("cost") : null,
				meanObservedCost: avg("cost"),
				meanLatencyMs: avg("latencyMs"),
				meanTokens: trials.every((r) => r.accountingComplete) ? avg("tokens") : null,
			};
		});
		fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ metadata, rows, summary,
			budgets: Object.fromEntries(variants.map((v) => [v, trialBudgets(v, timeout, maxCost)])) }, null, 2), {
			mode: 0o600,
		});
		if (fs.existsSync(path.join(config, "subagents-ex")))
			fs.cpSync(path.join(config, "subagents-ex"), path.join(out, "state"), { recursive: true });
		console.table(summary);
	} finally {
		fs.rmSync(config, { recursive: true, force: true });
	}
}
