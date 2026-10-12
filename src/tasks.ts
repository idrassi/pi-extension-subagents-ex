/** Session-owned background tasks, persisted independently of result collection. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { aggregateUsage, summarizeOutput } from "./format.ts";
import { readJson, writeJson } from "./files.ts";
import { STATE_DIR } from "./store.ts";
import type { RunMode, SubagentDetails, UsageStats } from "./types.ts";
import { emptyUsage } from "./types.ts";

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
	errorMessage?: string;
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
	const { id, kind, label, status, startedAt, endedAt, notify, summary, usage, result, errorMessage } = task;
	return { id, kind, label, status, startedAt, endedAt, notify, summary, usage, result, errorMessage };
}

export class TaskManager {
	private tasks: ManagedTask[] = [];
	private callbacks: SettleCallback[] = [];
	private dir: string;
	constructor(sessionId: string = randomUUID()) {
		this.dir = path.join(STATE_DIR, "tasks", createHash("sha256").update(sessionId).digest("hex"));
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
				const task: ManagedTask = { ...saved, controller: new AbortController(), done: Promise.resolve() };
				if (task.status === "running" || task.status === "queued") {
					task.status = "interrupted";
					task.endedAt = Date.now();
					task.errorMessage = "Parent stopped before task settled. Inspect the saved runs and resume explicitly.";
					this.save(task);
				}
				this.tasks.push(task);
			} catch {
				/* one damaged snapshot does not hide the other tasks */
			}
		}
		this.tasks.sort((a, b) => a.startedAt - b.startedAt);
	}

	onSettle(callback: SettleCallback): void {
		this.callbacks.push(callback);
	}
	private save(task: ManagedTask): void {
		writeJson(path.join(this.dir, `${task.id}.json`), serializeTask(task));
	}

	start(kind: RunMode, label: string, notify: boolean, exec: TaskExecutor): ManagedTask {
		const task: ManagedTask = {
			id: `task-${randomUUID()}`,
			kind,
			label,
			notify,
			status: "queued",
			startedAt: Date.now(),
			summary: "(queued)",
			usage: emptyUsage(),
			controller: new AbortController(),
			done: Promise.resolve(),
		};
		this.save(task);
		this.tasks.push(task);
		const progress = (result: AgentToolResult<SubagentDetails>) => {
			task.result = result;
			task.usage = aggregateUsage(result.details.results);
			task.status = result.details.results.some((r) => r.status !== "queued") ? "running" : "queued";
			task.summary =
				result.details.results.map((r) => `${r.agent}: ${r.status}, ${r.usage.turns} turns`).join("; ") || "(queued)";
			this.save(task);
		};
		task.done = Promise.resolve().then(async () => {
			try {
				const result = await exec(task.controller.signal, progress);
				task.result = result;
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
			}
		});
		return task;
	}
	get(id: string): ManagedTask | undefined {
		return this.tasks.find((t) => t.id === id);
	}
	list(): ManagedTask[] {
		return [...this.tasks];
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
