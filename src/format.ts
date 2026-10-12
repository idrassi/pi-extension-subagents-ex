/**
 * Formatting and extraction helpers shared by the runner, renderers and dashboard.
 */

import * as os from "node:os";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { RunRecord, RunStatus, UsageStats } from "./types.ts";
import { emptyUsage } from "./types.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

type ThemeFg = (color: any, text: string) => string;

export function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: ThemeFg): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
		}
	}
	return "";
}

export function getResultOutput(record: RunRecord): string {
	if (record.status !== "ok") {
		return record.errorMessage || record.stderr || getFinalOutput(record.messages) || "(no output)";
	}
	return getFinalOutput(record.messages) || "(no output)";
}

/** Truncate to a UTF-8 byte budget without splitting multibyte characters. */
export function truncateToBytes(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean; omittedBytes: number } {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= maxBytes) return { text, truncated: false, omittedBytes: 0 };
	const bytes = Buffer.from(text, "utf8");
	let end = Math.max(0, Math.min(maxBytes, bytes.length));
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	const truncated = bytes.subarray(0, end).toString("utf8");
	return { text: truncated, truncated: true, omittedBytes: byteLength - Buffer.byteLength(truncated, "utf8") };
}

export function aggregateUsage(records: { usage: UsageStats }[]): UsageStats {
	const total = emptyUsage();
	for (const r of records) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		total.contextTokens = Math.max(total.contextTokens, r.usage.contextTokens);
	}
	return total;
}

/** Convert internal stats into the pi-ai Usage shape used for tool result accounting. */
export function toModelUsage(stats: UsageStats): Usage {
	return {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: stats.input + stats.output + stats.cacheRead + stats.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost },
	};
}

/** First non-empty line, capped — used as a one-line task summary. */
export function summarizeOutput(text: string, max = 140): string {
	const line =
		text
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0 && !l.startsWith("#")) ?? "";
	if (!line) return "(no output)";
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function statusLabel(status: RunStatus): string {
	switch (status) {
		case "ok":
			return "ok";
		case "running":
			return "running";
		case "queued":
			return "queued";
		case "budget":
			return "budget";
		case "timeout":
			return "timeout";
		case "max-turns":
			return "max-turns";
		case "aborted":
			return "aborted";
		case "error":
			return "error";
		case "interrupted":
			return "interrupted";
	}
}
