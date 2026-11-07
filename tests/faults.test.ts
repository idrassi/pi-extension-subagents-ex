import { agent, defaults, temp } from "./setup.ts";
import test, { mock, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import lockfile, { type LockOptions } from "proper-lockfile";
import { Runner, RunStop } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";
import { emptyUsage, newRunRecord, type RunRecord, type WorktreeInfo } from "../src/types.ts";
import {
	ARTIFACTS_DIR, RUNS_DIR, STATE_DIR, claimWorktree, getRunOutputPage, listWorktreeRecords,
	loadRunById, registerWorktree, runFile, runOutputFile, saveRun, unregisterWorktree, worktreeIsActive,
} from "../src/store.ts";
import { createWorktree, exportPatch, git, removeWorktree } from "../src/worktree.ts";

const rpc = fileURLToPath(new URL("./fixtures/fault-rpc.mjs", import.meta.url));
const gitWrapper = new URL("./fixtures/fault-git.mjs", import.meta.url).href;
const lockFixture = fileURLToPath(new URL("./fixtures/fault-lock-holder.ts", import.meta.url));
const directory = () => fs.mkdtempSync(path.join(temp, "fault-"));

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, message);
		await delay(10);
	}
}
async function bounded<T>(pending: Promise<T>, ms = 5000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Fault fixture did not finish")), ms);
		})]);
	} finally { if (timer) clearTimeout(timer); }
}
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`injected ${code}`), { code });
}
async function checked(args: string[], cwd: string): Promise<string> {
	const result = await git(args, cwd);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}
async function workspace(t: TestContext) {
	const repo = directory();
	await checked(["init", "--initial-branch=main"], repo);
	fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
	await checked(["add", "tracked.txt"], repo);
	await checked(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"], repo);
	const info = await createWorktree(repo, `run-${randomUUID()}`);
	registerWorktree(`run-${randomUUID()}`, info);
	t.after(async () => {
		assert.equal((await removeWorktree(info, true)).ok, true);
		await unregisterWorktree(info.path);
	});
	fs.writeFileSync(path.join(info.path, "tracked.txt"), "staged\n");
	await checked(["add", "tracked.txt"], info.path);
	fs.writeFileSync(path.join(info.path, "tracked.txt"), "unstaged\n");
	fs.writeFileSync(path.join(info.path, "new.txt"), "untracked\n");
	const index = (await checked(["rev-parse", "--path-format=absolute", "--git-path", "index"], info.path)).trim();
	return { info, index, originalIndex: fs.readFileSync(index) };
}
function registryFile(info: WorktreeInfo): string {
	return path.join(STATE_DIR, "worktrees", `${createHash("sha256").update(info.path).digest("hex")}.json`);
}
function registry(info: WorktreeInfo) {
	const record = listWorktreeRecords().find((record) => record.path === info.path);
	assert.ok(record, "worktree registry entry was lost");
	return record;
}
function runnerFor(info: WorktreeInfo) {
	const runner = new Runner({ scheduler: new Scheduler(),
		invocation: { command: process.execPath, prefix: [rpc] }, killGraceMs: 100, stallTimeoutMs: 5000 });
	const source = newRunRecord(`run-${randomUUID()}`, agent.name, agent.source, "source", info.path);
	return { runner, start: (signal?: AbortSignal) => runner.run({ ...defaults, cwd: info.path }, agent, "offline fault test",
		{ worktree: info, resumeFrom: source }, undefined, signal) };
}
function assertNoTemporaryFiles(runId?: string): void {
	if (fs.existsSync(ARTIFACTS_DIR))
		assert.deepEqual(fs.readdirSync(ARTIFACTS_DIR).filter((name) => name.startsWith("index-") || name.endsWith(".tmp")), []);
	if (runId) {
		assert.ok(!fs.existsSync(`${runFile(runId)}.lock`));
		assert.deepEqual(fs.readdirSync(RUNS_DIR).filter((name) => name.startsWith(`${runId}.`) && name.endsWith(".tmp")), []);
	}
}
async function assertSettled(runner: Runner, run: RunRecord, space: Awaited<ReturnType<typeof workspace>>, charged = true) {
	const expected = charged ? 0.375 : 0;
	assert.equal(run.usage.cost, expected);
	assert.equal(run.usage.input, charged ? 30 : 0);
	assert.equal(run.usage.output, charged ? 15 : 0);
	if (charged) {
		assert.equal(run.attemptHistory![0].usage.cost, expected);
		assert.equal(run.messages.length, 1);
		assert.equal(run.usage.turns, 1);
		assert.ok(run.childPid);
		assert.equal(alive(run.childPid), false, "RPC peer survived export failure");
	}
	const state = await runner.scheduler.snapshot();
	assert.equal(state.cost, expected);
	assert.equal(state.runs, 1);
	assert.equal(state.usageByRun[run.id].usage.cost, expected, "ledger lost its usage owner/charges");
	// Two billable entries plus the (zero-remainder) statistics reconciliation receipt.
	if (charged) assert.equal(Object.keys(state.usageByRun[run.id].usageEvents!).length, 3);
	assert.deepEqual(state.leases, []);
	assert.deepEqual(state.requests, []);
	assert.deepEqual(runner.activeRunIds(), []);
	assert.deepEqual(fs.readFileSync(space.index), space.originalIndex, "export changed the real staged index");
	assert.equal(fs.readFileSync(path.join(space.info.path, "tracked.txt"), "utf8"), "unstaged\n");
	assertNoTemporaryFiles(run.id);
}
function assertUnowned(info: WorktreeInfo): void {
	const record = registry(info);
	assert.equal(record.ownerPid, undefined);
	assert.equal(record.ownerRunId, undefined);
	assert.equal(worktreeIsActive(record), false);
	assert.ok(!fs.existsSync(`${registryFile(info)}.lock`));
}
async function assertPatch(run: RunRecord, info: WorktreeInfo): Promise<void> {
	assert.ok(run.artifacts?.patch);
	assert.deepEqual(run.artifacts.changedFiles.sort(), ["new.txt", "tracked.txt", "worker.txt"]);
	await checked(["apply", "--check", run.artifacts.patch], info.repoRoot);
}

function installGitFault(t: TestContext, mode: string) {
	const dir = directory();
	const realGit = process.env.PATH!.split(path.delimiter).map((entry) => path.join(entry, "git")).find((file) => fs.existsSync(file));
	assert.ok(realGit, "Git must be available for local fixtures");
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nimport ${JSON.stringify(gitWrapper)};\n`, { mode: 0o700 });
	const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, PI_FAULT_GIT_REAL: path.resolve(realGit),
		PI_FAULT_GIT_MODE: mode, PI_FAULT_GIT_DIRECTORY: dir, PI_FAULT_GIT_ARTIFACTS: ARTIFACTS_DIR };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const restore = () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	};
	t.after(restore);
	return { dir, restore, release: () => fs.writeFileSync(path.join(dir, "release-export"), "release\n") };
}
function gitEvents(dir: string): Array<{ pid: number; childPid?: number; args: string[]; phase: string; index: string; indexExists?: boolean; lockExists?: boolean }> {
	return fs.readFileSync(path.join(dir, "git.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
function assertGitExited(dir: string): void {
	for (const event of gitEvents(dir)) {
		assert.equal(alive(event.pid), false, "Git wrapper survived the export");
		if (event.childPid) assert.equal(alive(event.childPid), false, "real Git survived the export");
		assert.ok(!fs.existsSync(event.index));
		assert.ok(!fs.existsSync(`${event.index}.lock`));
	}
}
async function holdLock(t: TestContext, file: string) {
	const proc = spawn(process.execPath, [lockFixture, file], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let stderr = "";
	proc.stdout!.resume();
	proc.stderr!.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	const closed = once(proc, "close");
	void closed.catch(() => {});
	t.after(async () => { proc.kill("SIGKILL"); await bounded(closed); });
	const [ready] = await bounded(once(proc, "message"));
	assert.deepEqual(ready, { ready: true });
	assert.ok(fs.existsSync(`${file}.lock`));
	return { pid: proc.pid!, release: async () => {
		proc.send("release");
		const [code, signal] = await bounded(closed);
		assert.equal(code, 0, `${signal}: ${stderr}`);
		assert.equal(alive(proc.pid!), false);
	} };
}
// Wait for actual EEXIST callbacks, not a sleep that merely hopes to hit the lock.
function observeContention(t: TestContext, file: string, count: number) {
	const lock = lockfile.lock;
	let attempts = 0;
	let observed!: () => void;
	const ready = new Promise<void>((resolve) => { observed = resolve; });
	// proper-lockfile normally uses its own graceful-fs copy. Its supported fs
	// adapter lets us observe real mkdir failures without replacing the lock.
	const observer = mock.method(lockfile, "lock", (target: string, options?: LockOptions) => {
		if (target !== file) return lock(target, options);
		return lock(target, { ...options, fs: { ...fs, mkdir(target: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) {
			fs.mkdir(target, (error) => {
				if (error?.code === "EEXIST" && ++attempts >= count) observed();
				callback(error);
			});
		} } });
	});
	const restore = () => { observer.mock.restore(); };
	t.after(restore);
	return { ready, restore };
}

test("ENOSPC writing settled output retains charges, patch fallback, and retryable transcript", { timeout: 10000 }, async (t) => {
	const space = await workspace(t);
	const { runner, start } = runnerFor(space.info);
	const { openSync, writeFileSync } = fs;
	let outputFd: number | undefined;
	let injected = false;
	const mocks = [
		mock.method(fs, "openSync", (file: any, ...args: any[]) => {
			const fd = (openSync as any)(file, ...args);
			if (String(file).includes(".output.txt.") && String(file).endsWith(".tmp")) outputFd = fd;
			else if (outputFd === fd) outputFd = undefined;
			return fd;
		}),
		mock.method(fs, "writeFileSync", (target: any, data: any, ...args: any[]) => {
			if (typeof target === "number" && target === outputFd) {
				injected = true;
				writeFileSync(target, Buffer.from(data).subarray(0, 5));
				throw errno("ENOSPC");
			}
			return (writeFileSync as any)(target, data, ...args);
		}),
	];
	syncBuiltinESMExports();
	let run: RunRecord;
	try { run = await start(); }
	finally { for (const item of mocks) item.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(injected);
	assert.equal(run.status, "error");
	assert.match(run.errorMessage!, /persistence\/update failed.*ENOSPC/);
	await assertSettled(runner, run, space);
	assertUnowned(space.info);
	await assertPatch(run, space.info);
	assert.ok(!fs.existsSync(runOutputFile(run.id)), "partial output was published");
	assert.equal(loadRunById(run.id)?.endedAt, undefined, "failed output must not commit terminal metadata");
	assert.equal(getRunOutputPage(run.id).text, "fault fixture complete");
	saveRun(run);
	assert.equal(loadRunById(run.id)?.status, "error");
	assert.equal(loadRunById(run.id)?.messages.length, 1);
	assert.equal(getRunOutputPage(run.id).outputFile, runOutputFile(run.id));
	await assertSettled(runner, run, space);
});

test("partial ENOSPC patch writes are not published and release the run's ownership", { timeout: 10000 }, async (t) => {
	const space = await workspace(t);
	const { runner, start } = runnerFor(space.info);
	const write = fs.writeFileSync;
	let attempted: string | undefined;
	const fault = mock.method(fs, "writeFileSync", (file: any, data: any, ...args: any[]) => {
		if (typeof file === "string" && path.dirname(file) === ARTIFACTS_DIR && /\.patch(?:\.|$)/.test(file)) {
			attempted = file;
			write(file, Buffer.from(data).subarray(0, 17));
			throw errno("ENOSPC");
		}
		return (write as any)(file, data, ...args);
	});
	syncBuiltinESMExports();
	let run: RunRecord;
	try { run = await start(); }
	finally { fault.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(attempted);
	assert.equal(run.status, "error");
	assert.match(run.errorMessage!, /Artifact export failed.*ENOSPC/);
	await assertSettled(runner, run, space);
	assertUnowned(space.info);
	assert.ok(!fs.existsSync(path.join(ARTIFACTS_DIR, `${run.id}.patch`)), "partial patch escaped a failed export");
	assert.equal(getRunOutputPage(run.id).text, "fault fixture complete");
	assert.equal(loadRunById(run.id)?.usage.cost, 0.375);
});

test("EACCES publishing an artifact manifest preserves a usable patch and cleans its temporary file", { timeout: 10000 }, async (t) => {
	const space = await workspace(t);
	const { runner, start } = runnerFor(space.info);
	const rename = fs.renameSync;
	let injected = false;
	const fault = mock.method(fs, "renameSync", (from: any, to: any) => {
		if (path.dirname(String(to)) === ARTIFACTS_DIR && String(to).endsWith(".json")) {
			injected = true;
			throw errno("EACCES");
		}
		return rename(from, to);
	});
	syncBuiltinESMExports();
	let run: RunRecord;
	try { run = await start(); }
	finally { fault.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(injected);
	assert.equal(run.status, "error");
	assert.match(run.errorMessage!, /Artifact export failed.*EACCES/);
	await assertSettled(runner, run, space);
	assertUnowned(space.info);
	await assertPatch(run, space.info);
	assert.ok(!fs.existsSync(run.artifacts!.manifest!));
	assert.equal(loadRunById(run.id)?.usage.cost, 0.375);
});

test("failed patch replacement preserves the last complete artifact", { timeout: 10000 }, async (t) => {
	const space = await workspace(t);
	const id = `run-${randomUUID()}`;
	const first = await exportPatch(space.info, id);
	const original = fs.readFileSync(first.patch!);
	fs.writeFileSync(path.join(space.info.path, "tracked.txt"), "later work\n");
	const rename = fs.renameSync;
	let injected = false;
	const fault = mock.method(fs, "renameSync", (from: any, to: any) => {
		if (String(to) === first.patch) { injected = true; throw errno("EACCES"); }
		return rename(from, to);
	});
	syncBuiltinESMExports();
	try { await assert.rejects(() => exportPatch(space.info, id), /EACCES/); }
	finally { fault.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(injected);
	assert.deepEqual(fs.readFileSync(first.patch!), original);
	assert.deepEqual(fs.readFileSync(space.index), space.originalIndex);
	assertNoTemporaryFiles();
	await checked(["apply", "--check", first.patch!], space.info.repoRoot);
	const repaired = await exportPatch(space.info, id);
	assert.notDeepEqual(fs.readFileSync(repaired.patch!), original);
	await checked(["apply", "--check", repaired.patch!], space.info.repoRoot);
});

for (const mode of ["fail-add", "fail-diff"]) {
	test(`${mode} removes disposable indexes/locks without losing charges or worker staging`, {
		skip: process.platform === "win32", timeout: 15000,
	}, async (t) => {
		const space = await workspace(t);
		const fault = installGitFault(t, mode);
		const { runner, start } = runnerFor(space.info);
		let run: RunRecord;
		try { run = await start(); } finally { fault.restore(); }
		assert.equal(run.status, "error");
		assert.match(run.errorMessage!, new RegExp(`Artifact export failed.*fault git ${mode === "fail-add" ? "add" : "diff"}`));
		const injected = gitEvents(fault.dir).find((event) => event.phase === "injected");
		assert.ok(injected?.indexExists, "fault did not reach a populated temporary index");
		if (mode === "fail-add") assert.equal(injected.lockExists, true);
		await assertSettled(runner, run, space);
		assertUnowned(space.info);
		assertGitExited(fault.dir);
		assert.ok(!fs.existsSync(path.join(ARTIFACTS_DIR, `${run.id}.patch`)));
		assert.equal(loadRunById(run.id)?.usage.cost, 0.375);
		const fallback = await exportPatch(space.info, run.id);
		await checked(["apply", "--check", fallback.patch!], space.info.repoRoot);
		assert.deepEqual(fs.readFileSync(space.index), space.originalIndex);
	});
}

test("abort during asynchronous Git export cannot release ownership ahead of the patch handoff", {
	skip: process.platform === "win32", timeout: 15000,
}, async (t) => {
	const space = await workspace(t);
	const fault = installGitFault(t, "pause-diff");
	const { runner, start } = runnerFor(space.info);
	const controller = new AbortController();
	let settled = false;
	const pending = start(controller.signal);
	void pending.then(() => { settled = true; });
	try {
		const ready = path.join(fault.dir, "export-ready.json");
		await until(() => fs.existsSync(ready), "real Git export did not reach its async barrier");
		const exporter = JSON.parse(fs.readFileSync(ready, "utf8"));
		const owner = registry(space.info);
		assert.ok(owner.ownerRunId);
		assert.equal(worktreeIsActive(owner), true);
		assert.equal(alive(exporter.pid), true);
		assert.ok(fs.existsSync(exporter.index));
		controller.abort(new RunStop("aborted", "Cancelled during export"));
		await assert.rejects(() => claimWorktree(space.info, "contender"), /in use/);
		assert.equal(settled, false, "abort returned while the exporter still owned a temporary index");
		assert.equal(registry(space.info).ownerRunId, owner.ownerRunId);
		const state = await runner.scheduler.snapshot();
		assert.equal(state.leases.length, 1);
		assert.equal(state.leases[0].id, owner.ownerRunId);
		assert.equal(state.leases[0].processReserved, true);
		assert.equal(state.cost, 0.375);
	} finally {
		fault.release();
		await bounded(pending);
		fault.restore();
	}
	const run = await pending;
	// Cleanup deliberately exports even on cancellation. This checks lifetime and
	// handoff, not cancellation status: Runner currently detaches the signal before export.
	await assertSettled(runner, run, space);
	assertUnowned(space.info);
	await assertPatch(run, space.info);
	assertGitExited(fault.dir);
});

test("cancelled scheduler async waiters finish cleanup only after a contended ledger unlocks", { timeout: 10000 }, async (t) => {
	const scheduler = new Scheduler(undefined, { concurrency: 1, maxRequests: 1 });
	const owner = await scheduler.acquire("owner");
	const request = await scheduler.acquireRequest("owner");
	const usage = { ...emptyUsage(), input: 30, cost: 0.375 };
	await scheduler.addUsage("owner", usage, "paid-before-contention");
	const baseline = process.getActiveResourcesInfo().filter((name) => name === "Timeout" || name === "FSEventWrap").sort();
	const controller = new AbortController();
	const reason = new Error("cancelled during ledger contention");
	let settled = 0;
	const waits = [scheduler.acquire("queued-worker", controller.signal), scheduler.acquireRequest("queued-request", controller.signal)]
		.map((pending) => assert.rejects(pending, (error) => error === reason).then(() => { settled++; }));
	let holder: Awaited<ReturnType<typeof holdLock>> | undefined;
	try {
		await until(async () => { const state = await scheduler.snapshot(); return state.leases.length === 2 && state.requests.length === 2; }, "waiters were not queued");
		holder = await holdLock(t, scheduler.file);
		const contention = observeContention(t, scheduler.file, 2);
		controller.abort(reason);
		await bounded(contention.ready);
		assert.equal(settled, 0);
		const blocked = await scheduler.snapshot();
		assert.equal(blocked.leases.length, 2);
		assert.equal(blocked.requests.length, 2);
		assert.equal(blocked.cost, 0.375);
		await holder.release();
		holder = undefined;
		await bounded(Promise.all(waits));
		contention.restore();
		const state = await scheduler.snapshot();
		assert.deepEqual(state.leases.map((lease) => lease.id), ["owner"]);
		assert.deepEqual(state.requests.map((reservation) => reservation.id), ["owner"]);
		assert.equal(state.leases[0].processReserved, true);
		assert.equal(state.cost, 0.375);
		assert.equal(state.usageByRun.owner.usageEvents!["paid-before-contention"], true);
		await scheduler.addUsage("owner", usage, "paid-before-contention");
		assert.equal((await scheduler.snapshot()).cost, 0.375);
		await until(() => JSON.stringify(process.getActiveResourcesInfo().filter((name) => name === "Timeout" || name === "FSEventWrap").sort()) === JSON.stringify(baseline), "cancelled waiters retained a watcher or timer");
	} finally {
		controller.abort(reason);
		await holder?.release();
		await bounded(Promise.all(waits));
		await request();
		await owner();
	}
	assert.deepEqual((await scheduler.snapshot()).leases, []);
	assert.deepEqual((await scheduler.snapshot()).requests, []);
	assert.ok(!fs.existsSync(`${scheduler.file}.lock`));
});

test("cancellation under worktree-claim lock contention cannot steal or release the live owner", { timeout: 10000 }, async (t) => {
	const space = await workspace(t);
	const releaseOwner = await claimWorktree(space.info, "original-owner");
	t.after(releaseOwner);
	const holder = await holdLock(t, registryFile(space.info));
	const contention = observeContention(t, registryFile(space.info), 1);
	const { runner, start } = runnerFor(space.info);
	const controller = new AbortController();
	let settled = false;
	const pending = start(controller.signal);
	void pending.then(() => { settled = true; });
	try {
		await bounded(contention.ready);
		controller.abort(new RunStop("aborted", "Cancelled while claiming worktree"));
		assert.equal(settled, false);
		assert.equal(registry(space.info).ownerRunId, "original-owner");
		assert.equal((await runner.scheduler.snapshot()).leases.length, 1);
	} finally { await holder.release(); contention.restore(); }
	try {
		const run = await bounded(pending);
		assert.equal(run.status, "aborted");
		assert.match(run.errorMessage!, /Cancelled while claiming worktree/);
		assert.equal(run.childPid, undefined);
		assert.equal(run.attempts, 0);
		await assertSettled(runner, run, space, false);
		assert.equal(registry(space.info).ownerRunId, "original-owner");
		assert.equal(worktreeIsActive(registry(space.info)), true);
		assert.ok(!fs.existsSync(path.join(ARTIFACTS_DIR, `${run.id}.patch`)), "failed claimant exported the active owner's work");
	} finally { controller.abort(); await releaseOwner(); }
	assertUnowned(space.info);
});

test("EACCES releasing a worktree fails closed and the same callback can retry without losing ownership", { timeout: 10000 }, async (t) => {
	const space = await workspace(t);
	const release = await claimWorktree(space.info, "owner");
	const file = registryFile(space.info);
	const committed = fs.readFileSync(file);
	const rename = fs.renameSync;
	let injected = false;
	const fault = mock.method(fs, "renameSync", (from: any, to: any) => {
		if (String(to) === file) { injected = true; throw errno("EACCES"); }
		return rename(from, to);
	});
	syncBuiltinESMExports();
	try { await assert.rejects(release, /EACCES/); }
	finally { fault.mock.restore(); syncBuiltinESMExports(); }
	assert.ok(injected);
	assert.deepEqual(fs.readFileSync(file), committed);
	assert.equal(registry(space.info).ownerRunId, "owner");
	assert.ok(!fs.existsSync(`${file}.lock`));
	assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(path.basename(file)) && name.endsWith(".tmp")), []);
	await assert.rejects(() => claimWorktree(space.info, "other-owner"), /in use/);
	await release();
	assertUnowned(space.info);
	const next = await claimWorktree(space.info, "next-owner");
	assert.equal(registry(space.info).ownerRunId, "next-owner");
	await next();
	assertUnowned(space.info);
});
