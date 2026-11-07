import { agent, defaults, temp } from "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runner, RunStop } from "../src/runner.ts";
import { Scheduler } from "../src/scheduler.ts";

const peer = fileURLToPath(new URL("./fixtures/process-peer.mjs", import.meta.url));
const guardFixture = fileURLToPath(new URL("./fixtures/guard-lifecycle.ts", import.meta.url));
const directory = () => fs.mkdtempSync(path.join(temp, "process-cleanup-"));
const pidFrom = (dir: string, name: string) => Number(fs.readFileSync(path.join(dir, name), "utf8"));
const exists = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		// Container PID 1 may not promptly reap orphan zombies. A zombie has been
		// terminated; waiting for ESRCH here would test the host's reaper, not us.
		if (process.platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
			if (state === "Z" || state === "X") return false;
		}
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function killTree(pid: number | undefined) {
	if (!pid) return;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

async function waitFor(predicate: () => boolean, message: string, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (!predicate() && Date.now() < deadline) await delay(10);
	assert.ok(predicate(), message);
}

async function bounded<T>(pending: Promise<T>, timeout: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Fixture did not exit within ${timeout}ms`)), timeout);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function fixture(args: string[]) {
	const proc = spawn(process.execPath, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PI_SUBAGENTS_EX_PARENT_PID: String(process.pid),
			PI_SUBAGENTS_EX_TREE_ID: "guard-lifecycle-test",
		},
	});
	let stderr = "";
	proc.stdout.resume();
	proc.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	const exited = once(proc, "close");
	void exited.catch(() => {});
	return { proc, exited, stderr: () => stderr };
}

const runnerFor = (scenario: string, dir: string, killGraceMs = 1000) =>
	new Runner({
		scheduler: new Scheduler(),
		invocation: { command: process.execPath, prefix: [peer, scenario, dir] },
		killGraceMs,
	});

test("cancellation owns the process group after its RPC leader exits", { skip: process.platform === "win32" }, async (t) => {
	for (const scenario of ["inherited-pipes", "ignored-pipes"]) {
		await t.test(scenario, { timeout: 10000 }, async () => {
			const dir = directory();
			const controller = new AbortController();
			const runner = runnerFor(scenario, dir);
			let completed = false;
			let leaderPid: number | undefined;
			const pending = runner.run(defaults, agent, "wait", {}, undefined, controller.signal, (run) => {
				leaderPid = run.childPid;
			});
			void pending.then(() => (completed = true));
			try {
				await waitFor(() => exists(dir, "ready"), "descendant was not ready");
				const descendantPid = pidFrom(dir, "descendant-pid");
				controller.abort(new RunStop("timeout", "Deterministic fixture deadline"));
				await waitFor(() => exists(dir, "leader-term"), "leader did not receive SIGTERM");
				await waitFor(() => exists(dir, "descendant-term"), "descendant did not receive/ignore SIGTERM");
				await waitFor(() => !isRunning(leaderPid!), "leader did not exit on SIGTERM");
				// This exceeds the old 100ms pipe-drain finish path, but not the
				// cancellation deadline. A released slot here leaves a live worker.
				await delay(175);
				assert.equal(completed, false, "run returned while its descendant was still alive");
				assert.equal((await runner.scheduler.snapshot()).leases.length, 1);
				assert.equal(isRunning(descendantPid), true);
				const run = await bounded(pending, 3000);
				assert.equal(run.status, "timeout", run.errorMessage);
				assert.match(run.errorMessage!, /Deterministic fixture deadline/);
				await waitFor(() => !isRunning(descendantPid), "SIGTERM-resistant descendant survived cancellation");
				assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
				assert.deepEqual(runner.activeRunIds(), []);
			} finally {
				controller.abort();
				killTree(leaderPid);
				if (exists(dir, "descendant-pid")) killTree(pidFrom(dir, "descendant-pid"));
				await bounded(pending, 3000);
			}
		});
	}
});

test("normal settlement and unexpected leader exit also clean remaining group members", {
	skip: process.platform === "win32",
	timeout: 10000,
}, async () => {
	for (const scenario of ["settled-descendant", "unexpected-exit"]) {
		const dir = directory();
		let leaderPid: number | undefined;
		try {
			const runner = runnerFor(scenario, dir, 200);
			const run = await runner.run(defaults, agent, "wait", {}, undefined, undefined, (run) => {
				leaderPid = run.childPid;
			});
			assert.equal(run.status, "error", run.errorMessage);
			assert.match(run.errorMessage!, /forced termination/);
			await waitFor(() => !isRunning(pidFrom(dir, "descendant-pid")), "leftover descendant survived leader exit");
			assert.equal((await runner.scheduler.snapshot()).leases.length, 0);
		} finally {
			killTree(leaderPid);
			if (exists(dir, "descendant-pid")) killTree(pidFrom(dir, "descendant-pid"));
		}
	}
});

test("a completed cancellation leaves no timers or pipes keeping its dispatcher alive", {
	skip: process.platform === "win32",
	timeout: 10000,
}, async () => {
	const dir = directory();
	const child = fixture([fileURLToPath(new URL("./fixtures/cleanup-dispatcher.ts", import.meta.url)), dir]);
	try {
		const [code, signal] = await bounded(child.exited, 7000);
		assert.equal(code, 0, `${signal}: ${child.stderr()}`);
		const run = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
		assert.equal(run.status, "timeout", run.errorMessage);
		await waitFor(() => !isRunning(pidFrom(dir, "descendant-pid")), "dispatcher exited without cleaning its group");
	} finally {
		child.proc.kill("SIGKILL");
		if (exists(dir, "descendant-pid")) killTree(pidFrom(dir, "descendant-pid"));
		await bounded(child.exited, 3000);
	}
});

test("guard cleans factory/start/shutdown/replacement resources, including unref'ed timers", { timeout: 10000 }, async () => {
	const dir = directory();
	const child = fixture([guardFixture, "lifecycle", dir]);
	try {
		const [code, signal] = await bounded(child.exited, 7000);
		assert.equal(code, 0, `${signal}: ${child.stderr()}`);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "lifecycle-result.json"), "utf8")), {
			intervals: 0,
			timeouts: 0,
		});
	} finally {
		child.proc.kill("SIGKILL");
		await bounded(child.exited, 3000);
	}
});

test("actual dispatcher death cannot strand guard workers in async startup or shutdown", {
	skip: process.platform === "win32",
	concurrency: 5,
	timeout: 15000,
}, async (t) => {
	await Promise.all(["startup-hang", "shutdown-hang", "hang-before-guard", "watchdog-hang", "watchdog-clean-exit"].map((scenario) =>
		t.test(scenario, { timeout: 12000 }, async () => {
			const dir = directory();
			const dispatcher = fixture([guardFixture, "dispatcher", dir, scenario]);
			let workerPid: number | undefined;
			try {
				await waitFor(() => exists(dir, "ready"), `guard worker did not start: ${dispatcher.stderr()}`);
				workerPid = pidFrom(dir, "worker-pid");
				const descendantPid = pidFrom(dir, "descendant-pid");
				assert.equal(isRunning(workerPid), true);
				dispatcher.proc.kill("SIGKILL");
				await bounded(dispatcher.exited, 3000);
				if (scenario === "startup-hang") {
					assert.equal(exists(dir, "startup-hang"), true, "fixture did not block startup");
				} else {
					await waitFor(() => exists(dir, "shutdown-started"), "parent death did not reach shutdown", 3000);
					if (scenario !== "watchdog-clean-exit")
						await waitFor(() => exists(dir, "shutdown-hang"), "fixture did not enter its hanging hook");
				}
				await waitFor(
					() => !isRunning(workerPid!) && !isRunning(descendantPid),
					`orphan survived ${scenario}: ${fs.readFileSync(path.join(dir, "worker.stderr"), "utf8")}`,
					7000,
				);
			} finally {
				dispatcher.proc.kill("SIGKILL");
				workerPid ??= exists(dir, "worker-pid") ? pidFrom(dir, "worker-pid") : undefined;
				killTree(workerPid);
				if (exists(dir, "descendant-pid")) killTree(pidFrom(dir, "descendant-pid"));
				await bounded(dispatcher.exited, 3000);
			}
		}),
	));
});
