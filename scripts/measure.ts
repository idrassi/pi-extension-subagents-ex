/** Offline real-pi resource/latency workload; never loads user credentials or real providers. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Timings, distribution, ioDelta, processIo, processRss } from "./measurement.ts";

const { values } = parseArgs({ options: {
	out: { type: "string" }, repeats: { type: "string", default: "3" }, fanout: { type: "string", default: "4" },
	scenarios: { type: "string", default: "single,fanout,parked" },
} });
const integer = (value: string, name: string, min: number, max: number) => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be ${min}–${max}`);
	return parsed;
};
const repeats = integer(values.repeats!, "repeats", 1, 20);
const fanout = integer(values.fanout!, "fanout", 2, 8);
const scenarios = values.scenarios!.split(",");
if (!scenarios.length || new Set(scenarios).size !== scenarios.length || scenarios.some((name) => !["single", "fanout", "parked"].includes(name)))
	throw new Error("scenarios must be a unique subset of single,fanout,parked");
const out = path.resolve(values.out ?? path.join(os.tmpdir(), `subagents-measurement-${Date.now()}-${randomUUID()}`));
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
if (fs.readdirSync(out).length) throw new Error("Measurement output directory must be empty");
const root = fileURLToPath(new URL("../", import.meta.url));
const provider = fileURLToPath(new URL("../benchmarks/fixtures/measure-provider.ts", import.meta.url));
const config = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-measure-config-"));
const saved = { ...process.env };
process.env.PI_CODING_AGENT_DIR = config;
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENTS_EX_")) delete process.env[key];
process.env.PI_SUBAGENTS_EX_POLICY = "off";
process.env.SUBAGENTS_MEASURE_REQUEST_LOG = path.join(out, "requests.jsonl");
const metadata = () => {
	let revision: string | null = null, dirty: boolean | null = null;
	try {
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
		const options = { cwd: root, encoding: "utf8" as const, env, timeout: 5000 };
		revision = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
		dirty = Boolean(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], options).trim());
	} catch { /* An unpacked source tree need not have repository metadata. */ }
	const source = createHash("sha256");
	for (const name of fs.readdirSync(path.join(root, "src")).filter((name) => name.endsWith(".ts")).sort()) {
		source.update(name); source.update(fs.readFileSync(path.join(root, "src", name)));
	}
	for (const file of [provider, fileURLToPath(import.meta.url), fileURLToPath(new URL("./measurement.ts", import.meta.url))]) source.update(fs.readFileSync(file));
	return { revision, dirty, sourceSha256: source.digest("hex"), node: process.version, platform: process.platform,
		arch: process.arch, release: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length };
};
function stateBytes(directory: string): number {
	if (!fs.existsSync(directory)) return 0;
	return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
		const file = path.join(directory, entry.name);
		return sum + (entry.isDirectory() ? stateBytes(file) : entry.isFile() ? fs.statSync(file).size : 0);
	}, 0);
}
let environment: ReturnType<typeof metadata> | null = null;
let sdkVersion: string | null = null;
const rows: Record<string, unknown>[] = [];
try {
	environment = metadata();
	fs.mkdirSync(path.join(config, "extensions"));
	fs.mkdirSync(path.join(config, "agents"));
	fs.mkdirSync(path.join(config, "workspace"));
	fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false } }));
	fs.writeFileSync(path.join(config, "extensions/provider.ts"), `export { default } from ${JSON.stringify(provider)};\n`);
	fs.writeFileSync(path.join(config, "extensions/subagents.ts"), `export { default } from ${JSON.stringify(path.join(root, "src/index.ts"))};\n`);
	fs.writeFileSync(path.join(config, "agents/measure-child.md"), "---\nname: measure-child\ndescription: Offline measurement child\nmodel: subagents-measure/local\ntools: read\nskills: false\ncontextFiles: false\nextensions: true\n---\nReturn the fixture response.\n");
	// Import only AFTER selecting private state. No user auth/models/settings are copied.
	const { Runner } = await import("../src/runner.ts");
	const { Scheduler } = await import("../src/scheduler.ts");
	const { STATE_DIR, runFile } = await import("../src/store.ts");
	const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
	sdkVersion = JSON.parse(fs.readFileSync(path.join(getPackageDir(), "package.json"), "utf8")).version;
	for (let repeat = 1; repeat <= repeats; repeat++) for (const scenario of scenarios) {
		const limits = { concurrency: scenario === "fanout" ? 2 : 1, maxProcesses: 8, maxQueued: 32, maxRequests: 1 };
		const scheduler = new Scheduler(undefined, limits);
		const timings = new Timings();
		const events: Parameters<Timings["observe"]>[0][] = [];
		const workerIo = new Map<string, { pid: number; counters: NonNullable<ReturnType<typeof processIo>>; at: number; settlementObserved: boolean }>();
		const observeIo = (runId: string, pid: number, settlementObserved = false) => {
			const counters = processIo(pid);
			if (counters) workerIo.set(runId, { pid, counters, at: performance.now(),
				settlementObserved: settlementObserved || workerIo.get(runId)?.settlementObserved === true });
		};
		const runner = new Runner({ scheduler, onEvent(event) {
			timings.observe(event); events.push(event);
			if (event.type === "settled" && event.pid) observeIo(event.runId, event.pid, true);
		} });
		const memory = new Map<string, { activeSamples: number; parkedSamples: number; activePeakRssBytes: number | null; parkedPeakRssBytes: number | null }>();
		const samplingErrors: string[] = [];
		let sampling: Promise<void> | undefined;
		const sample = () => {
			if (sampling) return;
			sampling = scheduler.snapshot().then((tree) => {
				for (const lease of tree.leases) {
					if (!lease.processReserved) continue;
					let pid: number | undefined;
					try {
						const disk = JSON.parse(fs.readFileSync(runFile(lease.id), "utf8"));
						pid = disk.record?.childPid;
					} catch { continue; }
					if (!pid) continue;
					observeIo(lease.id, pid);
					const rss = processRss(pid);
					if (rss === null) continue;
					let measured = memory.get(lease.id);
					if (!measured) memory.set(lease.id, (measured = { activeSamples: 0, parkedSamples: 0, activePeakRssBytes: null, parkedPeakRssBytes: null }));
					if (lease.parked > 0) {
						measured.parkedSamples++;
						measured.parkedPeakRssBytes = Math.max(measured.parkedPeakRssBytes ?? 0, rss);
					} else if (lease.active) {
						measured.activeSamples++;
						measured.activePeakRssBytes = Math.max(measured.activePeakRssBytes ?? 0, rss);
					}
				}
			}).catch((error) => { if (!samplingErrors.length) samplingErrors.push(String(error)); }).finally(() => { sampling = undefined; });
		};
		const delay = monitorEventLoopDelay({ resolution: 10 });
		const beforeIo = processIo(process.pid), beforeBytes = stateBytes(STATE_DIR);
		const started = performance.now();
		delay.enable();
		const timer = setInterval(sample, 40);
		const controller = new AbortController();
		const pending = Array.from({ length: scenario === "fanout" ? fanout : 1 }, () => runner.run(
			{ cwd: path.join(config, "workspace"), depth: 0 },
			{ name: "measurement", description: "Offline resource workload", filePath: "measurement", source: "user",
				systemPrompt: "Return the fixture response.", model: "subagents-measure/local", tools: ["subagent"],
				skills: false, contextFiles: false, extensions: true },
			scenario === "parked" ? "MEASURE_DELEGATE" : "MEASURE_STREAM", { timeoutSeconds: 30, maxTurns: 4 }, undefined, controller.signal));
		let runs: Awaited<ReturnType<InstanceType<typeof Runner>["run"]>>[];
		try { runs = await Promise.all(pending); }
		finally { controller.abort(); await Promise.allSettled(pending); clearInterval(timer); await sampling; delay.disable(); }
		const elapsedMs = performance.now() - started;
		const dispatcherIo = ioDelta(beforeIo, processIo(process.pid));
		const tree = await scheduler.snapshot();
		const requests = fs.readFileSync(process.env.SUBAGENTS_MEASURE_REQUEST_LOG!, "utf8").trim().split("\n").filter(Boolean)
			.map((line) => JSON.parse(line)).filter((event) => event.treeId === scheduler.id);
		let active = 0, peakRequests = 0;
		for (const request of requests) { active += request.phase === "start" ? 1 : -1; peakRequests = Math.max(peakRequests, active); }
		const expectedCost = requests.filter((request) => request.phase === "start").length * 0.001;
		const accounting = { syntheticReportedCost: tree.cost, expectedSyntheticCost: expectedCost,
			matches: Math.abs(tree.cost - expectedCost) < 1e-10 && Math.abs(runs.reduce((total, run) => total + run.usage.cost, 0) - expectedCost) < 1e-10 };
		const runTimings = timings.results();
		const telemetryComplete = runTimings.length === runs.length && runTimings.every((run) =>
			run.queueWaitMs !== null && run.completionDeliveryMs !== null && run.attempts.length &&
			run.attempts.every((attempt) => attempt.startupMs !== null && attempt.firstTokenMs !== null));
		rows.push({ scenario, repeat, treeId: scheduler.id, limits, elapsedMs, telemetryComplete,
			runs: runs.map((run) => ({ id: run.id, status: run.status, error: run.errorMessage })), timings: runTimings, events,
			latencyMs: { queueWait: distribution(runTimings.map((run) => run.queueWaitMs)),
				startup: distribution(runTimings.flatMap((run) => run.attempts.map((attempt) => attempt.startupMs))),
				firstToken: distribution(runTimings.flatMap((run) => run.attempts.map((attempt) => attempt.firstTokenMs))),
				completionDelivery: distribution(runTimings.map((run) => run.completionDeliveryMs)) },
			workerMemory: [...memory].map(([runId, samples]) => ({ runId, ...samples })),
			workerIo: [...workerIo].map(([runId, observation]) => ({ runId, ...observation })),
			eventLoopDelayMs: { count: delay.count, mean: delay.count ? delay.mean / 1e6 : null,
				p50: delay.count ? delay.percentile(50) / 1e6 : null, p95: delay.count ? delay.percentile(95) / 1e6 : null,
				max: delay.count ? delay.max / 1e6 : null },
			dispatcherIo, retainedStateByteDelta: stateBytes(STATE_DIR) - beforeBytes, samplingErrors,
			peakRequests, remainingRequests: tree.requests.length, remainingLeases: tree.leases.length, accounting });
		console.log(`${scenario} #${repeat}: ${elapsedMs.toFixed(1)} ms; ${requests.length / 2} local requests; peak ${peakRequests}`);
		if (runs.some((run) => run.status !== "ok") || active !== 0 || peakRequests > limits.maxRequests || tree.leases.length || tree.requests.length || !accounting.matches || !telemetryComplete || samplingErrors.length)
			throw new Error(`Offline workload invariants failed: ${JSON.stringify(rows.at(-1))}`);
	}
	const summary = scenarios.map((scenario) => {
		const selected = rows.filter((row) => row.scenario === scenario);
		const timing = selected.flatMap((row) => row.timings as ReturnType<Timings["results"]>);
		return { scenario, trials: selected.length, elapsedMs: distribution(selected.map((row) => row.elapsedMs as number)),
			queueWaitMs: distribution(timing.map((run) => run.queueWaitMs)),
			startupMs: distribution(timing.flatMap((run) => run.attempts.map((attempt) => attempt.startupMs))),
			firstTokenMs: distribution(timing.flatMap((run) => run.attempts.map((attempt) => attempt.firstTokenMs))),
			completionDeliveryMs: distribution(timing.map((run) => run.completionDeliveryMs)) };
	});
	fs.cpSync(STATE_DIR, path.join(out, "state"), { recursive: true });
	fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ version: 1, offline: true, paidRequests: false,
		environment: { ...environment, sdkVersion }, parameters: { repeats, fanout, scenarios, sampleIntervalMs: 40 },
		definitions: { startup: "spawn to RPC prompt acceptance", firstToken: "prompt send to first observed text/thinking delta, per attempt",
			queueWait: "worker admission only; model-request wait is included in first-token latency",
			completionDelivery: "last settlement observed to cleanup/artifact persistence completion",
			memory: "sampled per-worker peak RSS under active or parked scheduler leases; Linux /proc only",
			io: "dispatcher /proc/self/io logical/disk counter deltas, including sampler overhead; scenario aggregate, not exact per-run attribution",
			workerIo: "last observed per-worker cumulative /proc/PID/io counters since process birth; sampled and at outer settlement; shutdown writes may be missed, descendants are sampled only",
			scope: "local synthetic workload through real pi, not production or model-quality measurements; top-level latency events only",
			state: "copied state is for inspection, not resume; embedded original temporary paths are no longer valid" }, rows, summary }, null, 2), { mode: 0o600 });
	console.log(`Measurement report: ${path.join(out, "summary.json")}`);
} catch (error) {
	try {
		const state = path.join(config, "subagents-ex");
		if (fs.existsSync(state)) fs.cpSync(state, path.join(out, "state"), { recursive: true });
		fs.writeFileSync(path.join(out, "failure.json"), JSON.stringify({ offline: true, paidRequests: false,
			environment: { ...environment, sdkVersion }, rows, error: error instanceof Error ? error.message : String(error) }, null, 2), { mode: 0o600 });
	} catch { console.error("Could not preserve partial measurement output"); }
	throw error;
} finally {
	fs.rmSync(config, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
}
