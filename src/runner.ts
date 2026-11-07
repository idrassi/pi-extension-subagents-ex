/** RPC process engine. Each attempt has its own transcript and resumable session. */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { validateOutput, validateOutputSchema } from "./contracts.ts";
import { aggregateUsage, getFinalOutput, truncateToBytes } from "./format.ts";
import { ARTIFACTS_DIR, SESSIONS_DIR, claimWorktree, registerWorktree, runOutputFile, saveRun } from "./store.ts";
import { BudgetError, Scheduler } from "./scheduler.ts";
import {
	emptyUsage,
	newRunRecord,
	type AttemptRecord,
	type RunDefaults,
	type RunOverrides,
	type RunRecord,
	type RunStatus,
	type UsageStats,
	type VerificationEvidence,
} from "./types.ts";
import { createWorktree, exportPatch, worktreeCwd } from "./worktree.ts";
import { MAX_TIMEOUT_SECONDS, numberControl, validateControls, validatePrompt } from "./validation.ts";
import { writeJson } from "./files.ts";
import {
	ManagedUsageTracker,
	copySessionForResume,
	directUsage,
	messageUsageKey,
	nativeUsage,
	nativeUsageKey,
	readSessionEntries,
	sessionEntryKey,
	usageStats,
	type AccountingMarker,
} from "./accounting.ts";

export interface Invocation {
	command: string;
	prefix?: string[];
}
export interface RunnerOptions {
	scheduler?: Scheduler;
	invocation?: Invocation;
	killGraceMs?: number;
	/** Progress watchdog; defaults to PI_SUBAGENTS_EX_STALL_TIMEOUT_MS or ten minutes. */
	stallTimeoutMs?: number;
}
interface AttemptAccounting {
	namespace: string;
	observeMessage: (message: Message) => boolean;
	recover: () => Promise<void>;
	captureStats: (totals: UsageStats) => Promise<void>;
}

export class RunStop extends Error {
	status: RunStatus;
	constructor(status: RunStatus, message: string) {
		super(message);
		this.status = status;
	}
}

function piInvocation(): Invocation {
	const runtime = /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath));
	if (!runtime) return { command: process.execPath };
	// Pi supplies its SDK through the extension loader, without a local SDK install.
	const cli = path.join(getPackageDir(), "dist", "bundle", "cli.js");
	return fs.existsSync(cli) ? { command: process.execPath, prefix: [cli] } : { command: "pi" };
}

export function addUsage(target: UsageStats, usage: Usage | undefined, turns = 0): void {
	target.turns += turns;
	if (!usage) return;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) target[key] += usage[key] || 0;
	target.cost += usage.cost?.total || 0;
	target.contextTokens = Math.max(target.contextTokens, usage.totalTokens || 0);
}

function statsUsage(data: any): UsageStats {
	return {
		...emptyUsage(),
		input: data?.tokens?.input ?? 0,
		output: data?.tokens?.output ?? 0,
		cacheRead: data?.tokens?.cacheRead ?? 0,
		cacheWrite: data?.tokens?.cacheWrite ?? 0,
		cost: data?.cost ?? 0,
	};
}

function stopFromSignal(signal: AbortSignal): RunStop {
	return signal.reason instanceof RunStop ? signal.reason : new RunStop("aborted", "Run cancelled");
}

function verification(messages: Message[]): VerificationEvidence[] {
	const calls = new Map<string, string>();
	const evidence: VerificationEvidence[] = [];
	for (const message of messages) {
		if (message.role === "assistant")
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === "bash" && typeof part.arguments.command === "string")
					calls.set(part.id, part.arguments.command);
			}
		if (message.role === "toolResult" && calls.has(message.toolCallId)) {
			const details = message.details as { exitCode?: number } | undefined;
			evidence.push({
				command: calls.get(message.toolCallId)!,
				exitCode: details?.exitCode ?? (message.isError ? undefined : 0),
				isError: message.isError,
				output: truncateToBytes(
					message.content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("\n"),
					8192,
				).text,
			});
		}
	}
	return evidence;
}

export class Runner {
	readonly scheduler: Scheduler;
	private options: RunnerOptions;
	private readonly stallTimeoutMs: number;
	private active = new Map<string, (message: string) => Promise<void>>();
	private budgetWatchers = new Set<(reason: string) => void>();
	private budgetTimer?: NodeJS.Timeout;
	private budgetChecking = false;
	private watchBudget(listener: (reason: string) => void): () => void {
		this.budgetWatchers.add(listener);
		this.budgetTimer ??= setInterval(() => {
			if (this.budgetChecking) return;
			this.budgetChecking = true;
			void this.scheduler.budgetReason().then((reason) => {
				if (reason) for (const watcher of this.budgetWatchers) watcher(reason);
			}, (err) => {
				for (const watcher of this.budgetWatchers) watcher(`Budget ledger unavailable: ${String(err)}`);
			}).finally(() => { this.budgetChecking = false; });
		}, 250);
		return () => {
			this.budgetWatchers.delete(listener);
			if (!this.budgetWatchers.size && this.budgetTimer) {
				clearInterval(this.budgetTimer);
				this.budgetTimer = undefined;
			}
		};
	}
	constructor(options: RunnerOptions = {}) {
		this.options = options;
		this.scheduler = options.scheduler ?? new Scheduler();
		this.stallTimeoutMs =
			numberControl(
				options.stallTimeoutMs ?? process.env.PI_SUBAGENTS_EX_STALL_TIMEOUT_MS,
				"PI_SUBAGENTS_EX_STALL_TIMEOUT_MS",
				1,
				MAX_TIMEOUT_SECONDS * 1000,
				true,
			) ?? 600_000;
	}

	activeRunIds(): string[] {
		return [...this.active.keys()];
	}
	async steer(id: string, message: string): Promise<void> {
		validatePrompt(message);
		const send = this.active.get(id);
		if (!send) throw new Error(`Run ${id} is not accepting steering; resume its saved session after completion`);
		await send(message);
	}

	async run(
		defaults: RunDefaults,
		agent: AgentConfig,
		task: string,
		overrides: RunOverrides = {},
		step?: number,
		signal?: AbortSignal,
		onUpdate?: (record: RunRecord) => void,
	): Promise<RunRecord> {
		const record = newRunRecord(
			`run-${randomUUID()}`,
			agent.name,
			agent.source,
			task,
			path.resolve(defaults.cwd, overrides.cwd ?? "."),
			step,
		);
		record.treeId = this.scheduler.id;
		record.parentRunId = process.env.PI_SUBAGENTS_EX_LEASE_ID;
		record.ownerPid = process.pid;
		record.attemptHistory = [];
		record.model = overrides.model ?? agent.model ?? defaults.model;
		record.outputFormat = overrides.outputSchema ? "json" : (overrides.outputFormat ?? "text");
		record.outputSchema = overrides.outputSchema;
		record.resumeOf = overrides.resumeFrom?.id;
		record.worktree = overrides.worktree;
		const controls = {
			timeoutSeconds: overrides.timeoutSeconds ?? agent.timeoutSeconds,
			maxTurns: overrides.maxTurns ?? agent.maxTurns,
			retries: overrides.retries ?? agent.retries ?? 0,
			maxCost: overrides.maxCost,
		};
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		let timer: NodeJS.Timeout | undefined;
		let releaseSlot: (() => Promise<void>) | undefined;
		let releaseWorktree: (() => Promise<void>) | undefined;
		let workspaceReady = false;
		let progressTimer: NodeJS.Timeout | undefined;
		let progressSavedAt = 0;
		const persist = () => {
			progressSavedAt = Date.now();
			saveRun(record);
			try {
				onUpdate?.(record);
			} catch {
				/* presentation observers do not own execution */
			}
		};
		const update = (immediate = true) => {
			if (immediate || Date.now() - progressSavedAt >= 100) {
				if (progressTimer) clearTimeout(progressTimer);
				progressTimer = undefined;
				persist();
			} else if (!progressTimer) {
				progressTimer = setTimeout(() => {
					progressTimer = undefined;
					try { persist(); }
					catch (err) { controller.abort(new RunStop("error", `Run persistence failed: ${String(err)}`)); }
				}, 100 - (Date.now() - progressSavedAt));
				progressTimer.unref();
			}
		};
		try {
			validateControls(controls);
			validatePrompt(task);
			if (overrides.outputSchema) validateOutputSchema(overrides.outputSchema);
			if (controls.timeoutSeconds !== undefined)
				timer = setTimeout(
					() => controller.abort(new RunStop("timeout", `Timed out after ${controls.timeoutSeconds}s`)),
					controls.timeoutSeconds * 1000,
				);
			controller.signal.throwIfAborted();
			update();
			releaseSlot = await this.scheduler.acquire(record.id, controller.signal);
			controller.signal.throwIfAborted();
			if (overrides.isolation === "worktree" && !record.worktree) {
				record.worktree = await createWorktree(record.cwd, record.id);
				registerWorktree(record.id, record.worktree);
				record.cwd = worktreeCwd(record.worktree);
			}
			// Chain ownership is held by the orchestrator; resumed/single worktrees are owned here.
			if (record.worktree && (!overrides.worktree || overrides.resumeFrom))
				releaseWorktree = await claimWorktree(record.worktree, record.id);
			workspaceReady = true;
			if (!fs.statSync(record.cwd).isDirectory()) throw new Error(`Invalid working directory: ${record.cwd}`);
			fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
			let feedback = "";
			for (let n = 1; n <= 1 + controls.retries; n++) {
				controller.signal.throwIfAborted();
				if (controls.maxTurns !== undefined && record.usage.turns >= controls.maxTurns)
					throw new RunStop("max-turns", `Turn budget reached (${controls.maxTurns})`);
				if (controls.maxCost !== undefined && record.usage.cost >= controls.maxCost)
					throw new RunStop("budget", `Run cost budget reached ($${controls.maxCost})`);
				const sessionFile = path.join(SESSIONS_DIR, `${record.id}-${n}.jsonl`);
				if (n === 1 && overrides.resumeFrom?.sessionFile)
					copySessionForResume(overrides.resumeFrom.sessionFile, sessionFile);
				const attempt: AttemptRecord = {
					number: n,
					status: "running",
					startedAt: Date.now(),
					diagnostics: [],
					messages: [],
					stderr: "",
					usage: emptyUsage(),
					sessionFile,
				};
				record.attemptHistory.push(attempt);
				record.attempts = n;
				record.messages = attempt.messages;
				record.sessionFile = sessionFile;
				record.status = "running";
				record.errorMessage = undefined;
				update();
				const contract =
					record.outputFormat === "json"
						? `\n\nReturn exactly one JSON value with no prose or markdown fences.${overrides.outputSchema ? ` Match this JSON Schema: ${JSON.stringify(overrides.outputSchema)}` : ""}`
						: "";
				const prompt = `Task: ${task}${feedback}${contract}`;
				validatePrompt(prompt);
				const namespace = `${record.id}-${n}`;
				const historical = readSessionEntries(sessionFile);
				const recovered = new Set(historical.map(sessionEntryKey));
				const baseline = emptyUsage();
				for (const entry of historical) {
					const message = (entry.message ?? entry) as Message;
					addUsage(baseline, nativeUsage(entry) ??
						(message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined));
				}
				// Match pi statistics: custom background receipts affect run totals, but
				// are not included in get_session_stats. Startup work is new, not baseline.
				const observedStats = emptyUsage();
				let statisticsRemainder: UsageStats | undefined;
				const seenMessages = new Set<string>();
				// RPC events and final cleanup can both request recovery. Serialize the
				// scans so reported totals, not just scheduler debits, remain idempotent.
				let recovery = Promise.resolve();
				const accounting: AttemptAccounting = {
					namespace,
					captureStats: async (totals) => {
						// Include entries written during the RPC request, then freeze the
						// remainder before stdin closes and shutdown hooks can append usage.
						await accounting.recover();
						statisticsRemainder = emptyUsage();
						for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
							statisticsRemainder[key] = Math.max(0, totals[key] - baseline[key] - observedStats[key]);
					},
					observeMessage: (message) => {
						const key = messageUsageKey(message, namespace);
						if (seenMessages.has(key)) return false;
						seenMessages.add(key);
						attempt.messages.push(message);
						if (message.role === "assistant" || message.role === "toolResult") {
							addUsage(
								attempt.usage,
								message.usage,
								message.role === "assistant" && !(message.stopReason === "aborted" && !message.usage?.totalTokens) ? 1 : 0,
							);
							addUsage(observedStats, message.usage);
						}
						return true;
					},
					recover: () => (recovery = recovery.then(async () => {
						for (const entry of readSessionEntries(sessionFile)) {
							const key = sessionEntryKey(entry);
							if (recovered.has(key)) continue;
							const usage = nativeUsage(entry);
							if (usage) {
								await this.scheduler.addUsage(record.id, usageStats(usage), nativeUsageKey(entry, namespace));
								addUsage(attempt.usage, usage);
								addUsage(observedStats, usage);
							} else if (entry.type === "custom" && entry.customType === "subagents-ex-accounting") {
								addUsage(attempt.usage, (entry.data as AccountingMarker).usage);
							} else {
								// Legacy peers may persist raw messages rather than typed session entries.
								const message = (entry.message ?? entry) as Message;
								if (message.role === "assistant" || message.role === "toolResult") {
									await this.scheduler.addUsage(record.id, directUsage(message, this.scheduler.id), messageUsageKey(message, namespace));
									accounting.observeMessage(message);
								}
							}
							recovered.add(key);
						}
						record.usage = aggregateUsage(record.attemptHistory!);
					})),
				};
				try {
					await this.attempt(
						record,
						attempt,
						agent,
						defaults,
						{ ...overrides, ...controls },
						prompt,
						controller.signal,
						update,
						accounting,
					);
				} finally {
					// Includes flushed usage even after SIGKILL, RPC truncation, or an early exit.
					await accounting.recover();
				}
				if (statisticsRemainder) {
					// Post-snapshot shutdown entries were recovered separately and must
					// neither mask this remainder nor be charged again through it.
					await this.scheduler.addUsage(record.id, statisticsRemainder, `stats:${namespace}`);
					for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) attempt.usage[key] += statisticsRemainder[key];
				}
				record.usage = aggregateUsage(record.attemptHistory);
				await this.reconcileUsage(record);
				record.status = attempt.status;
				record.stopReason = attempt.stopReason;
				record.errorMessage = attempt.errorMessage;
				record.stderr = attempt.stderr;
				record.exitCode = attempt.exitCode;
				if (record.status === "ok" && record.outputFormat === "json") {
					try {
						record.parsedOutput = validateOutput(getFinalOutput(attempt.messages), overrides.outputSchema);
					} catch (err) {
						record.status = attempt.status = "error";
						record.errorMessage = attempt.errorMessage = String(err);
					}
				}
				update();
				if (record.status !== "error" || n > controls.retries || controller.signal.aborted) break;
				feedback = `\n\n[Attempt ${n} failed: ${record.errorMessage || record.stderr.slice(-2000) || "unknown error"}. Inspect existing changes before continuing; do not repeat completed side effects.]`;
			}
		} catch (err) {
			const stop = controller.signal.aborted
				? stopFromSignal(controller.signal)
				: err instanceof RunStop
					? err
					: err instanceof BudgetError
						? new RunStop("budget", err.message)
						: new RunStop("error", err instanceof Error ? err.message : String(err));
			record.status = stop.status;
			record.errorMessage = stop.message;
			const attempt = record.attemptHistory.at(-1);
			if (attempt && !attempt.endedAt) {
				attempt.status = stop.status;
				attempt.errorMessage = stop.message;
				attempt.endedAt = Date.now();
			}
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.active.delete(record.id);
			try {
				if (releaseSlot) await this.reconcileUsage(record);
			} catch (err) {
				record.errorMessage = `Usage reconciliation failed: ${String(err)}`;
				record.status = "error";
			}
			try {
				if (workspaceReady && record.worktree && fs.existsSync(record.worktree.path))
					record.artifacts = await exportPatch(record.worktree, record.id);
				record.artifacts ??= { changedFiles: [], verification: [] };
				record.artifacts.verification = verification(record.attemptHistory.flatMap((a) => a.messages));
				record.artifacts.output = runOutputFile(record.id);
				record.artifacts.manifest = path.join(ARTIFACTS_DIR, `${record.id}.json`);
				writeJson(record.artifacts.manifest, { runId: record.id, ...record.artifacts });
			} catch (err) {
				record.errorMessage = `${record.errorMessage ? `${record.errorMessage}; ` : ""}Artifact export failed: ${String(err)}`;
				if (record.status === "ok") record.status = "error";
			}
			try {
				await releaseWorktree?.();
			} catch (err) {
				record.errorMessage = `Worktree release failed: ${String(err)}`;
				record.status = "error";
			}
			try {
				await releaseSlot?.();
			} catch (err) {
				record.errorMessage = `Scheduler release failed: ${String(err)}`;
				record.status = "error";
			}
			record.endedAt = Date.now();
			try {
				update();
			} catch (err) {
				record.status = "error";
				record.errorMessage = `Run persistence/update failed: ${String(err)}`;
			}
		}
		return record;
	}

	private async reconcileUsage(record: RunRecord): Promise<void> {
		const observed = await this.scheduler.subtreeUsage(record.id);
		const attempt = record.attemptHistory?.at(-1);
		if (!attempt) return;
		// Tool results normally carry descendant usage. Fill only missing deltas when
		// cancellation interrupts that handoff; preserve accurate per-attempt totals.
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const)
			attempt.usage[key] += Math.max(0, observed[key] - record.usage[key]);
		record.usage = aggregateUsage(record.attemptHistory!);
	}

	private attempt(
		record: RunRecord,
		attempt: AttemptRecord,
		agent: AgentConfig,
		defaults: RunDefaults,
		options: RunOverrides,
		prompt: string,
		signal: AbortSignal,
		update: (immediate?: boolean) => void,
		accounting: AttemptAccounting,
	): Promise<void> {
		return new Promise((resolve) => {
			const args = ["--mode", "rpc", "--session", attempt.sessionFile];
			if (record.model) args.push("--model", record.model);
			const thinking = options.thinking ?? agent.thinking ?? defaults.thinkingLevel;
			if (thinking) args.push("--thinking", thinking);
			if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
			else if (agent.excludeTools?.length) args.push("--exclude-tools", agent.excludeTools.join(","));
			if (!agent.skills) args.push("--no-skills");
			if (!agent.contextFiles) args.push("--no-context-files");
			if (!agent.extensions) args.push("--no-extensions");
			args.push("--extension", fileURLToPath(new URL("./child-guard.ts", import.meta.url)));
			const promptFile = path.join(SESSIONS_DIR, `${record.id}-system.md`);
			fs.writeFileSync(promptFile, agent.systemPrompt, { mode: 0o600 });
			if (agent.systemPrompt.trim()) args.push("--append-system-prompt", promptFile);
			const invocation = this.options.invocation ?? piInvocation();
			const priorTurns = record.usage.turns;
			const priorCost = record.usage.cost;
			const proc = spawn(invocation.command, [...(invocation.prefix ?? []), ...args], {
				cwd: record.cwd,
				shell: false,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENTS_EX_DEPTH: String(defaults.depth + 1),
					PI_SUBAGENTS_EX_TREE_ID: this.scheduler.id,
					PI_SUBAGENTS_EX_LEASE_ID: record.id,
					PI_SUBAGENTS_EX_PARENT_PID: String(process.pid),
					PI_SUBAGENTS_EX_RUN_TURNS: String(options.maxTurns === undefined ? Infinity : options.maxTurns - priorTurns),
					PI_SUBAGENTS_EX_RUN_COST: String(options.maxCost === undefined ? Infinity : options.maxCost - priorCost),
					PI_SUBAGENTS_EX_TASK_NAMESPACE: accounting.namespace,
					PI_SUBAGENTS_EX_SESSION_FILE: attempt.sessionFile,
				},
			});
			record.childPid = proc.pid;
			let buffer = "";
			let processing = Promise.resolve();
			let leaderExited = false;
			let outputDrained = false;
			let cleanupComplete = false;
			let finished = false;
			let settled = false;
			let stopping: RunStop | undefined;
			let grace: NodeJS.Timeout | undefined;
			let forceFinish: NodeJS.Timeout | undefined;
			let exitDrain: NodeJS.Timeout | undefined;
			let stallTimer: NodeJS.Timeout | undefined;
			let watchingProgress = false;
			let waitingForRequest = false;
			let unsubscribeBudget = () => {};
			const waitingForSubagents = new Set<string>();
			let requestId = 0;
			const provenance = new ManagedUsageTracker();
			const pending = new Map<
				string,
				{ resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
			>();
			const hasProcesses = () => {
				if (!proc.pid) return false;
				if (process.platform === "win32") return !leaderExited;
				try {
					process.kill(-proc.pid, 0);
					return true;
				} catch (err) {
					return (err as NodeJS.ErrnoException).code !== "ESRCH";
				}
			};
			let triedWindowsTreeKill = false;
			const signalProcess = (sig: NodeJS.Signals) => {
				if (!proc.pid) return;
				if (process.platform !== "win32") {
					try {
						// The process group can outlive its RPC leader (and all of its pipes).
						process.kill(-proc.pid, sig);
						return;
					} catch {
						/* Fall back to the leader only while it is still owned by ChildProcess. */
					}
				} else if (!leaderExited && !triedWindowsTreeKill) {
					triedWindowsTreeKill = true;
					// Windows has no POSIX group signals or graceful proc.kill(). Kill the tree
					// while its root still exists; bound/reap taskkill rather than detaching it.
					const result = spawnSync(
						path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
						["/PID", String(proc.pid), "/T", "/F"],
						{ stdio: "ignore", windowsHide: true, timeout: 1000 },
					);
					if (result.status === 0) return;
				}
				if (!leaderExited) {
					try {
						proc.kill(sig);
					} catch {
						/* already exited */
					}
				}
			};
			const armEscalation = () => {
				if (grace || cleanupComplete) return;
				grace = setTimeout(() => {
					grace = undefined;
					if (hasProcesses()) {
						stopping ??= new RunStop(
							"error",
							leaderExited
								? "Child left running descendants after exit; forced termination"
								: "Child did not exit after agent_settled; forced termination",
						);
						signalProcess("SIGKILL");
					}
					cleanupComplete = true;
					forceFinish = setTimeout(() => {
						proc.stdin.destroy();
						proc.stdout.destroy();
						proc.stderr.destroy();
						finish();
					}, 1000);
					if (leaderExited && outputDrained) void processing.finally(finish);
				}, this.options.killGraceMs ?? 5000);
			};
			const clearStallTimer = () => {
				if (stallTimer) clearTimeout(stallTimer);
				stallTimer = undefined;
			};
			const stop = (reason: RunStop) => {
				if (stopping || finished) return;
				stopping = reason;
				clearStallTimer();
				signalProcess("SIGTERM");
				armEscalation();
			};
			const noteProgress = () => {
				if (!watchingProgress || stopping || finished || leaderExited || settled || waitingForRequest || waitingForSubagents.size) return;
				if (stallTimer) stallTimer.refresh();
				else
					stallTimer = setTimeout(
						() =>
							stop(new RunStop("timeout", `No model or tool progress for ${this.stallTimeoutMs / 1000}s (stall timeout)`)),
						this.stallTimeoutMs,
					);
			};
			const request = (type: string, payload: Record<string, unknown> = {}): Promise<any> =>
				new Promise((res, rej) => {
					if (finished || stopping || leaderExited || proc.stdin.destroyed) return rej(new Error("Child is stopping"));
					const id = String(++requestId);
					const timer = setTimeout(() => {
						pending.delete(id);
						rej(new Error(`RPC ${type} timed out`));
					}, 15_000);
					pending.set(id, { resolve: res, reject: rej, timer });
					proc.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, (err) => {
						if (err) {
							clearTimeout(timer);
							pending.delete(id);
							rej(err);
						}
					});
				});
			const finish = () => {
				if (finished) return;
				// Neither leader exit nor pipe closure proves a detached group is gone.
				// Keep the slot and escalation deadline until the group disappears or
				// SIGKILL has been delivered. Do not wait for orphan zombies to be reaped.
				if (!cleanupComplete && hasProcesses()) {
					armEscalation();
					return;
				}
				finished = true;
				if (grace) clearTimeout(grace);
				if (forceFinish) clearTimeout(forceFinish);
				if (exitDrain) clearTimeout(exitDrain);
				proc.stdin.destroy();
				proc.stdout.destroy();
				proc.stderr.destroy();
				clearStallTimer();
				unsubscribeBudget();
				signal.removeEventListener("abort", onAbort);
				this.active.delete(record.id);
				for (const req of pending.values()) {
					clearTimeout(req.timer);
					req.reject(new Error("Child process exited"));
				}
				pending.clear();
				attempt.endedAt = Date.now();
				attempt.exitCode = proc.exitCode ?? undefined;
				attempt.status =
					stopping?.status ??
					(settled && proc.exitCode === 0
						? attempt.stopReason === "aborted"
							? "aborted"
							: attempt.stopReason === "stop" || attempt.stopReason === "length"
								? "ok"
								: "error"
						: "error");
				if (stopping) attempt.errorMessage = stopping.message;
				if (attempt.status === "error" && !attempt.errorMessage)
					attempt.errorMessage =
						attempt.stderr ||
						(settled
							? "Child settled without a final assistant response or exited unsuccessfully"
							: "Child exited before agent_settled");
				try {
					fs.rmSync(promptFile, { force: true });
				} catch {
					/* diagnostic file may remain */
				}
				resolve();
			};
			const handleEvent = async (event: any) => {
				if (finished) return;
				if (event.type === "extension_error" && event.extensionPath?.endsWith("child-guard.ts"))
					stop(new RunStop("error", `Child guard failed: ${event.error}`));
				if (event.type === "entry_appended" && event.entry?.customType === "subagents-ex-limit")
					stop(new RunStop(event.entry.data.status, event.entry.data.reason));
				if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
					provenance.observe(event, this.scheduler.id);
				if (event.type === "agent_end") provenance.clear();
				if (event.type === "entry_appended" || event.type === "compaction_end") {
					await accounting.recover();
					update(false);
					if (!settled && options.maxCost !== undefined && record.usage.cost >= options.maxCost)
						stop(new RunStop("budget", `Run cost budget reached ($${options.maxCost})`));
				}
				if (event.type === "message_end" && event.message) {
					const msg = provenance.annotate(event.message, this.scheduler.id) as Message;
					accounting.observeMessage(msg);
					if (msg.role === "assistant" || msg.role === "toolResult")
						await this.scheduler.addUsage(record.id, directUsage(msg, this.scheduler.id), messageUsageKey(msg, accounting.namespace));
					if (msg.role === "assistant") {
						attempt.stopReason = msg.stopReason;
						attempt.errorMessage = msg.errorMessage;
						if (msg.errorMessage) attempt.diagnostics.push(msg.errorMessage);
					}
					record.usage = aggregateUsage(record.attemptHistory!);
					update(false);
					if (options.maxCost !== undefined && record.usage.cost >= options.maxCost && attempt.stopReason === "toolUse")
						stop(new RunStop("budget", `Run cost budget reached ($${options.maxCost})`));
					if (options.maxTurns !== undefined && record.usage.turns > options.maxTurns)
						stop(new RunStop("max-turns", `Turn budget reached (${options.maxTurns})`));
				}
				if (event.type === "agent_settled" && !settled && !stopping) {
					settled = true;
					this.active.delete(record.id);
					await accounting.captureStats(statsUsage(await request("get_session_stats")));
					proc.stdin.end();
					armEscalation();
				}
			};
			const line = (text: string) => {
				if (!text.trim()) return;
				let event: any;
				try {
					event = JSON.parse(text);
				} catch {
					stop(new RunStop("error", "Invalid JSON in child RPC stream"));
					return;
				}
				// Observe actual events on arrival, before asynchronous accounting can delay delivery.
				// RPC responses, stderr, and unrelated notifications are not evidence of progress.
				if (event.type === "entry_appended" && event.entry?.customType === "subagents-ex-request-wait") {
					waitingForRequest = event.entry.data?.waiting === true;
					if (waitingForRequest) clearStallTimer();
					else noteProgress();
				}
				if (event.type === "agent_settled") {
					watchingProgress = false;
					clearStallTimer();
				}
				if (
					event.type === "tool_execution_start" &&
					(event.toolName === "subagent" || event.toolName === "subagent_task_output")
				) {
					// Waiting parents can outlive a stall window; each descendant has its own watchdog.
					waitingForSubagents.add(event.toolCallId);
					clearStallTimer();
				}
				if (event.type === "tool_execution_end") waitingForSubagents.delete(event.toolCallId);
				if (
					[
						"message_start",
						"message_update",
						"message_end",
						"tool_execution_start",
						"tool_execution_update",
						"tool_execution_end",
					].includes(event.type)
				)
					noteProgress();
				if (event.type === "response") {
					const req = pending.get(event.id);
					if (req) {
						clearTimeout(req.timer);
						pending.delete(event.id);
						event.success ? req.resolve(event.data) : req.reject(new Error(event.error ?? "RPC command rejected"));
					}
					return;
				}
				if (event.type === "extension_ui_request") {
					// A child cannot authorize new project code or other interactive requests.
					proc.stdin.write(
						`${JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: false, cancelled: true })}\n`,
					);
					return;
				}
				processing = processing.then(() => handleEvent(event)).catch((err) => stop(new RunStop("error", String(err))));
			};
			proc.stdout.setEncoding("utf8");
			proc.stderr.setEncoding("utf8");
			proc.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) {
					buffer = "";
					stop(new RunStop("error", "Child RPC frame exceeds 32 MB"));
					return;
				}
				let end: number;
				while ((end = buffer.indexOf("\n")) !== -1) {
					const next = buffer.slice(0, end);
					buffer = buffer.slice(end + 1);
					line(next);
				}
			});
			proc.stderr.on("data", (chunk: string) => {
				attempt.stderr += chunk;
				if (Buffer.byteLength(attempt.stderr) > 32 * 1024)
					attempt.stderr = truncateToBytes(attempt.stderr.slice(-32 * 1024), 32 * 1024).text;
			});
			proc.stdin.on("error", (err) => {
				if (!settled) stop(new RunStop("error", `Child input failed: ${err.message}`));
			});
			proc.on("error", (err) => {
				stopping = new RunStop("error", `Failed to spawn pi: ${err.message}`);
				finish();
			});
			proc.on("exit", () => {
				leaderExited = true;
				if (finished) return;
				clearStallTimer();
				for (const req of pending.values()) {
					clearTimeout(req.timer);
					req.reject(new Error("Child process exited"));
				}
				pending.clear();
				// Bound pipe draining independently of process-group cancellation. This must
				// not replace the hard-kill fallback or cancel an existing grace deadline.
				exitDrain = setTimeout(() => {
					exitDrain = undefined;
					outputDrained = true;
					proc.stdout.destroy();
					proc.stderr.destroy();
					void processing.finally(finish);
				}, 100);
			});
			proc.on("close", () => {
				outputDrained = true;
				if (exitDrain) clearTimeout(exitDrain);
				exitDrain = undefined;
				if (buffer.trim()) line(buffer);
				void processing.finally(finish);
			});
			const onAbort = () => stop(stopFromSignal(signal));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			unsubscribeBudget = this.watchBudget((reason) => {
				if (!finished && !settled) stop(new RunStop("budget", reason));
			});
			void (async () => {
				update(); // Persist child ownership before admitting a model request.
				const commands = await request("get_commands");
				if (!commands?.commands?.some((c: { name: string }) => c.name === "subagents-ex-guard"))
					throw new Error("Required child budget guard did not load");
				watchingProgress = true;
				noteProgress();
				await request("prompt", { message: prompt });
				if (!settled && !stopping && !leaderExited && !finished)
					this.active.set(record.id, async (message) => {
						await request("steer", { message });
					});
			})().catch((err) => stop(new RunStop("error", String(err))));
		});
	}
}

let defaultRunner: Runner | undefined;
export function runAgent(
	defaults: RunDefaults,
	agent: AgentConfig,
	task: string,
	overrides: RunOverrides = {},
	step?: number,
	signal?: AbortSignal,
	onUpdate?: (record: RunRecord) => void,
): Promise<RunRecord> {
	return (defaultRunner ??= new Runner()).run(defaults, agent, task, overrides, step, signal, onUpdate);
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results = new Array<TOut>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index], index);
			}
		}),
	);
	return results;
}
