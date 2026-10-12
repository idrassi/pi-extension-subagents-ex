/** Atomic run snapshots, complete attempt transcripts, and per-worktree ownership. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type DisplayItem, getDisplayItems, getFinalOutput } from "./format.ts";
import { isProcessAlive, readJson, withLock, writeJson } from "./files.ts";
import type { RunRecord, RunStatus, WorktreeInfo } from "./types.ts";

export const STATE_DIR = path.join(getAgentDir(), "subagents-ex");
export const RUNS_DIR = path.join(STATE_DIR, "runs");
export const SESSIONS_DIR = path.join(STATE_DIR, "sessions");
export const ARTIFACTS_DIR = path.join(STATE_DIR, "artifacts");
const WORKTREES_DIR = path.join(STATE_DIR, "worktrees");

export interface StoredRun extends RunRecord {
	version: 2;
	ts: number;
	durationMs: number;
	finalOutput: string;
	transcript: DisplayItem[];
}

export interface RunSummary {
	id: string;
	file: string;
	ts: number;
	durationMs: number;
	agent: string;
	status: RunStatus;
	task: string;
	cost: number;
	model?: string;
	cwd: string;
}

export function runFile(id: string): string {
	if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid run id");
	return path.join(RUNS_DIR, `${id}.json`);
}

export function saveRun(record: RunRecord): void {
	const stored: StoredRun = {
		...record,
		version: 2,
		ts: record.startedAt,
		durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
		finalOutput: getFinalOutput(record.messages),
		transcript: getDisplayItems(record.messages),
	};
	writeJson(runFile(record.id), stored);
	if (record.endedAt) {
		for (const old of listRuns(Number.MAX_SAFE_INTEGER)
			.filter((r) => r.status !== "running" && r.status !== "queued")
			.slice(200)) {
			try {
				fs.unlinkSync(old.file);
			} catch {
				/* concurrent prune */
			}
		}
	}
}

export function listRuns(limit: number): RunSummary[] {
	let files: string[];
	try {
		files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const runs: RunSummary[] = [];
	for (const name of files) {
		const file = path.join(RUNS_DIR, name);
		const r = loadRun(file);
		if (!r) continue;
		runs.push({
			id: r.id,
			file,
			ts: r.ts ?? r.startedAt,
			durationMs: r.durationMs,
			agent: r.agent,
			status: r.status,
			task: r.task,
			cost: r.usage?.cost ?? 0,
			model: r.model,
			cwd: r.cwd,
		});
	}
	return runs.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export function loadRun(file: string): StoredRun | null {
	try {
		const run = readJson<StoredRun>(file);
		if (!run) return null;
		if (
			!run.endedAt &&
			run.ownerPid &&
			!isProcessAlive(run.ownerPid) &&
			(!run.childPid || !isProcessAlive(run.childPid))
		) {
			run.status = "interrupted";
			run.endedAt = run.startedAt + run.durationMs;
			run.errorMessage = "Dispatcher stopped before the run settled; resume the saved child session explicitly.";
			const attempt = run.attemptHistory?.at(-1);
			if (attempt && !attempt.endedAt) {
				attempt.status = "interrupted";
				attempt.endedAt = run.endedAt;
				attempt.errorMessage = run.errorMessage;
			}
		}
		return run;
	} catch {
		return null;
	}
}

export function loadRunById(id: string): StoredRun | null {
	return loadRun(runFile(id));
}

export interface WorktreeRecord extends WorktreeInfo {
	runId: string;
	createdAt: number;
	ownerPid?: number;
	ownerRunId?: string;
}

function worktreeFile(worktreePath: string): string {
	return path.join(WORKTREES_DIR, `${createHash("sha256").update(worktreePath).digest("hex")}.json`);
}

/** Independent files eliminate the shared registry's lost-update race. */
export function registerWorktree(runId: string, info: WorktreeInfo): void {
	writeJson(worktreeFile(info.path), { ...info, runId, createdAt: Date.now() } satisfies WorktreeRecord);
}

export function listWorktreeRecords(): WorktreeRecord[] {
	const records = new Map<string, WorktreeRecord>();
	try {
		for (const r of readJson<WorktreeRecord[]>(path.join(STATE_DIR, "worktrees.json")) ?? []) records.set(r.path, r);
	} catch {
		/* corrupted legacy registry must not hide new records */
	}
	try {
		for (const name of fs.readdirSync(WORKTREES_DIR).filter((f) => f.endsWith(".json"))) {
			try {
				const r = readJson<WorktreeRecord>(path.join(WORKTREES_DIR, name));
				if (r) records.set(r.path, r);
			} catch {
				/* keep other entries visible */
			}
		}
	} catch {
		/* no worktrees yet */
	}
	return [...records.values()];
}

export function worktreeIsActive(record: WorktreeRecord): boolean {
	return record.ownerPid !== undefined && isProcessAlive(record.ownerPid);
}

export async function claimWorktree(info: WorktreeInfo, runId: string): Promise<() => Promise<void>> {
	const file = worktreeFile(info.path);
	await withLock(file, () => {
		const record = readJson<WorktreeRecord>(file) ?? { ...info, runId, createdAt: Date.now() };
		if (worktreeIsActive(record)) throw new Error(`Worktree is in use by ${record.ownerRunId}`);
		writeJson(file, { ...record, ownerPid: process.pid, ownerRunId: runId });
	});
	return async () =>
		withLock(file, () => {
			const record = readJson<WorktreeRecord>(file);
			if (record?.ownerRunId === runId) {
				delete record.ownerPid;
				delete record.ownerRunId;
				writeJson(file, record);
			}
		});
}

export async function unregisterWorktree(worktreePath: string): Promise<void> {
	fs.rmSync(worktreeFile(worktreePath), { force: true });
	const legacy = path.join(STATE_DIR, "worktrees.json");
	if (fs.existsSync(legacy))
		await withLock(legacy, () =>
			writeJson(
				legacy,
				(readJson<WorktreeRecord[]>(legacy) ?? []).filter((r) => r.path !== worktreePath),
			),
		);
}
