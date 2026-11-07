/** Deterministic statistics and optional Linux process observations for local measurements. */
import * as fs from "node:fs";

export interface MeasurementEvent {
	type: "queued" | "admitted" | "spawned" | "prompt_sent" | "prompt_accepted" | "first_token" | "settled" | "finished";
	runId: string;
	attempt?: number;
	pid?: number;
	at: number;
}
export interface Distribution {
	count: number;
	min: number | null;
	p50: number | null;
	p95: number | null;
	max: number | null;
}
/** Nearest-rank quantiles; missing observations are not manufactured as zero. */
export function distribution(values: readonly (number | null | undefined)[]): Distribution {
	const sorted = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
	const quantile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
	return { count: sorted.length, min: sorted[0] ?? null, p50: quantile(0.5), p95: quantile(0.95), max: sorted.at(-1) ?? null };
}
function duration(end: number | undefined, start: number | undefined): number | null {
	return end !== undefined && start !== undefined && end >= start ? end - start : null;
}
export interface AttemptTiming {
	attempt: number;
	startupMs: number | null;
	firstTokenMs: number | null;
}
export interface RunTiming {
	runId: string;
	queueWaitMs: number | null;
	completionDeliveryMs: number | null;
	attempts: AttemptTiming[];
}
export class Timings {
	private runs = new Map<string, { events: Partial<Record<MeasurementEvent["type"], number>>; attempts: Map<number, Partial<Record<MeasurementEvent["type"], number>>> }>();
	observe(event: MeasurementEvent): void {
		if (!Number.isFinite(event.at) || event.at < 0 || !event.runId) return;
		let run = this.runs.get(event.runId);
		if (!run) this.runs.set(event.runId, (run = { events: {}, attempts: new Map() }));
		if (event.type === "settled" || run.events[event.type] === undefined) run.events[event.type] = event.at;
		if (event.attempt !== undefined) {
			let attempt = run.attempts.get(event.attempt);
			if (!attempt) run.attempts.set(event.attempt, (attempt = {}));
			if (attempt[event.type] === undefined) attempt[event.type] = event.at;
		}
	}
	results(): RunTiming[] {
		return [...this.runs].map(([runId, run]) => ({
			runId,
			queueWaitMs: duration(run.events.admitted, run.events.queued),
			completionDeliveryMs: duration(run.events.finished, run.events.settled),
			attempts: [...run.attempts].sort(([a], [b]) => a - b).map(([attempt, events]) => ({
				attempt,
				startupMs: duration(events.prompt_accepted, events.spawned),
				firstTokenMs: duration(events.first_token, events.prompt_sent),
			})),
		}));
	}
}
export interface ProcessIo { rchar: number; wchar: number; readBytes: number; writeBytes: number }
export function parseProcessIo(text: string): ProcessIo | null {
	const values = new Map(text.split("\n").map((line) => {
		const [key, value] = line.split(":");
		return [key, Number(value?.trim())] as const;
	}));
	const result = { rchar: values.get("rchar"), wchar: values.get("wchar"), readBytes: values.get("read_bytes"), writeBytes: values.get("write_bytes") };
	return Object.values(result).every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) ? result as ProcessIo : null;
}
export function processIo(pid: number): ProcessIo | null {
	if (process.platform !== "linux") return null;
	try { return parseProcessIo(fs.readFileSync(`/proc/${pid}/io`, "utf8")); } catch { return null; }
}
export function processRss(pid: number): number | null {
	if (process.platform !== "linux") return null;
	try {
		const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
		return match ? Number(match[1]) * 1024 : null;
	} catch { return null; }
}
export function ioDelta(before: ProcessIo | null, after: ProcessIo | null): ProcessIo | null {
	if (!before || !after) return null;
	const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key as keyof ProcessIo] - before[key as keyof ProcessIo]])) as unknown as ProcessIo;
	return Object.values(delta).every((n) => Number.isSafeInteger(n) && n >= 0) ? delta : null;
}
