/** Session-owned background tasks, persisted independently of result collection. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { aggregateUsage, summarizeOutput, truncateToBytes } from "./format.ts";
import { boundedResult, compactDetails } from "./results.ts";
import { readJson, writeJson } from "./files.ts";
import { STATE_DIR } from "./store.ts";
import type { RunMode, SubagentDetails, UsageStats } from "./types.ts";
import { emptyUsage } from "./types.ts";
import { numberControl } from "./validation.ts";

export type TaskStatus = "queued" | "running" | "done" | "partial" | "error" | "killed" | "interrupted";
export interface TaskSnapshot {
	id: string;
	kind: RunMode;
	label: string;
	status: TaskStatus;
	startedAt: number;
	endedAt?: number;
	notify: boolean;
	summary: string;
	usage: UsageStats;
	result?: AgentToolResult<SubagentDetails>;
	/** Lightweight lookup survives eviction of settled result bodies from memory. */
	runIds?: string[];
	errorMessage?: string;
	/** Continuations share transcript UUIDs, but never another run/attempt's task namespace. */
	owner?: { sessionId: string; runNamespace?: string };
}
export interface ManagedTask extends TaskSnapshot {
	controller: AbortController;
	done: Promise<void>;
}
export type TaskExecutor = (
	signal: AbortSignal,
	onUpdate: (result: AgentToolResult<SubagentDetails>) => void,
) => Promise<AgentToolResult<SubagentDetails>>;
export type SettleCallback = (task: ManagedTask) => void | Promise<void>;

export function serializeTask(task: TaskSnapshot): TaskSnapshot {
	const { id, kind, label, status, startedAt, endedAt, notify, summary, usage, result, runIds, errorMessage, owner } = task;
	return { id, kind, label, status, startedAt, endedAt, notify, summary, usage, result, runIds, errorMessage, owner };
}

function compactTaskResult(result: AgentToolResult<SubagentDetails>): AgentToolResult<SubagentDetails> {
	const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	return boundedResult(text, compactDetails(result.details), result.usage);
}

export function taskSummary(task: TaskSnapshot) {
	return {
		id: task.id, kind: task.kind, label: truncateToBytes(task.label, 128).text,
		status: task.status, startedAt: task.startedAt, endedAt: task.endedAt, notify: task.notify,
		summary: truncateToBytes(task.summary, 256).text, usage: task.usage,
		errorMessage: task.errorMessage ? truncateToBytes(task.errorMessage, 512).text : undefined,
		runIds: (task.runIds ?? task.result?.details.results.map((run) => run.id) ?? []).slice(0, 32),
	};
}

export class TaskManager {
	private tasks: ManagedTask[] = [];
	private callbacks: SettleCallback[] = [];
	private pendingSaves = new Map<string, NodeJS.Timeout>();
	private saveErrors = new Map<string, unknown>();
	private dir: string;
	private readonly owner: NonNullable<TaskSnapshot["owner"]>;
	constructor(sessionId: string = randomUUID(), runNamespace = process.env.PI_SUBAGENTS_EX_TASK_NAMESPACE) {
		this.owner = { sessionId, runNamespace };
		// Preserve top-level session recovery and its legacy on-disk location. A
		// managed worker gets a fresh namespace per attempt, including on resume.
		const key = runNamespace === undefined ? sessionId : JSON.stringify([sessionId, runNamespace]);
		this.dir = path.join(STATE_DIR, "tasks", createHash("sha256").update(key).digest("hex"));
		let files: string[] = [];
		try {
			files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		} catch {
			/* new session */
		}
		for (const file of files) {
			try {
				const saved = readJson<TaskSnapshot>(path.join(this.dir, file));
				if (!saved) continue;
				const task: ManagedTask = { ...saved,
					runIds: saved.runIds ?? saved.result?.details.results.map((run) => run.id) ?? [],
					result: saved.result ? compactTaskResult(saved.result) : undefined,
					controller: new AbortController(), done: Promise.resolve() };
				if (task.status === "running" || task.status === "queued") {
					task.status = "interrupted";
					task.endedAt = Date.now();
					task.errorMessage = "Parent stopped before task settled. Inspect the saved runs and resume explicitly.";
					this.save(task);
				}
				this.tasks.push({ ...task, result: undefined });
			} catch {
				/* one damaged snapshot does not hide the other tasks */
			}
		}
		this.tasks.sort((a, b) => a.startedAt - b.startedAt);
	}

	onSettle(callback: SettleCallback): void {
		this.callbacks.push(callback);
	}
	private save(task: ManagedTask, immediate = true): void {
		const pending = this.pendingSaves.get(task.id);
		if (!immediate) {
			if (pending) return;
			const timer = setTimeout(() => {
				this.pendingSaves.delete(task.id);
				try { this.save(task); }
				catch (err) { this.saveErrors.set(task.id, err); task.controller.abort(err); }
			}, 100);
			timer.unref();
			this.pendingSaves.set(task.id, timer);
			return;
		}
		if (pending) clearTimeout(pending);
		this.pendingSaves.delete(task.id);
		writeJson(path.join(this.dir, `${task.id}.json`), serializeTask(task));
	}

	start(kind: RunMode, label: string, notify: boolean, exec: TaskExecutor): ManagedTask {
		const task: ManagedTask = {
			id: `task-${randomUUID()}`,
			kind,
			label: truncateToBytes(label, 256).text,
			notify,
			owner: this.owner,
			status: "queued",
			startedAt: Date.now(),
			summary: "(queued)",
			usage: emptyUsage(),
			controller: new AbortController(),
			done: Promise.resolve(),
		};
		this.save(task);
		this.tasks.push(task);
		const progress = (rawResult: AgentToolResult<SubagentDetails>) => {
			const result = compactTaskResult(rawResult);
			const status = result.details.results.some((r) => r.status !== "queued") ? "running" : "queued";
			const changed = status !== task.status;
			task.result = result;
			task.runIds = result.details.results.map((run) => run.id);
			task.usage = aggregateUsage(result.details.results);
			task.status = status;
			task.summary =
				result.details.results.map((r) => `${r.agent}: ${r.status}, ${r.usage.turns} turns`).join("; ") || "(queued)";
			this.save(task, changed);
		};
		task.done = Promise.resolve().then(async () => {
			try {
				const result = compactTaskResult(await exec(task.controller.signal, progress));
				task.result = result;
				task.runIds = result.details.results.map((run) => run.id);
				task.usage = aggregateUsage(result.details.results);
				task.status = task.controller.signal.aborted
					? "killed"
					: result.details.status === "ok"
						? "done"
						: result.details.status === "partial"
							? "partial"
							: "error";
				task.errorMessage =
					result.details.errorMessage ?? result.details.results.find((r) => r.status !== "ok")?.errorMessage;
				const text = result.content.find((c) => c.type === "text");
				task.summary = summarizeOutput(text?.type === "text" ? text.text : "");
			} catch (err) {
				task.status = task.controller.signal.aborted ? "killed" : "error";
				task.errorMessage = task.summary = err instanceof Error ? err.message : String(err);
			} finally {
				task.endedAt = Date.now();
				if (this.saveErrors.has(task.id)) {
					task.status = "error";
					task.errorMessage = `Task persistence failed: ${String(this.saveErrors.get(task.id))}`;
					this.saveErrors.delete(task.id);
				}
				try {
					this.save(task);
				} catch (err) {
					task.status = "error";
					task.errorMessage = `Task persistence failed: ${String(err)}`;
				}
				for (const cb of this.callbacks) {
					try {
						await cb(task);
					} catch {
						/* observers do not own execution */
					}
				}
				// Keep only lightweight settled state; explicit get() hydrates on demand.
				this.tasks[this.tasks.indexOf(task)] = { ...task, result: undefined };
			}
		});
		return task;
	}
	get(id: string): ManagedTask | undefined {
		const task = this.tasks.find((t) => t.id === id);
		if (!task || task.result || !task.endedAt) return task;
		const saved = readJson<TaskSnapshot>(path.join(this.dir, `${task.id}.json`));
		return saved?.result ? { ...task, result: compactTaskResult(saved.result) } : task;
	}
	list(): ManagedTask[] {
		return [...this.tasks];
	}
	page(options: { cursor?: string; limit?: number } = {}) {
		const limit = numberControl(options.limit ?? 10, "limit", 1, 20, true)!;
		let cursor: [number, string] | undefined;
		if (options.cursor !== undefined) {
			try {
				if (options.cursor.length > 1024 || !/^[\w-]+$/.test(options.cursor)) throw new Error();
				const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
				if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) ||
					typeof parsed[1] !== "string" || !/^task-[a-zA-Z0-9-]+$/.test(parsed[1])) throw new Error();
				cursor = parsed as [number, string];
			} catch { throw new Error("Invalid task cursor"); }
		}
		const ordered = this.tasks.slice().sort((a, b) => b.startedAt - a.startedAt || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1))
			.filter((task) => !cursor || task.startedAt < cursor[0] || (task.startedAt === cursor[0] && task.id < cursor[1]));
		const tasks = ordered.slice(0, limit);
		const last = tasks.at(-1);
		return { tasks, nextCursor: ordered.length > limit && last
			? Buffer.from(JSON.stringify([last.startedAt, last.id])).toString("base64url") : undefined };
	}
	runningCount(): number {
		return this.tasks.filter((t) => t.status === "running" || t.status === "queued").length;
	}
	kill(id: string): boolean {
		const t = this.get(id);
		if (!t || t.endedAt) return false;
		t.controller.abort();
		return true;
	}
	killAll(): void {
		for (const t of this.tasks) if (!t.endedAt) t.controller.abort();
	}
	async shutdown(): Promise<void> {
		this.killAll();
		await Promise.allSettled(this.tasks.map((t) => t.done));
	}
}

export async function waitForTask(task: ManagedTask, timeoutSeconds: number, signal?: AbortSignal): Promise<void> {
	if (task.endedAt || signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, timeoutSeconds * 1000);
		signal?.addEventListener("abort", done, { once: true });
		void task.done.then(done, done);
	});
}
