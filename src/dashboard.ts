/**
 * /agents dashboard — a live TUI overlay listing background tasks and recent
 * run history, with kill and drill-down support.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, shortenPath, summarizeOutput } from "./format.ts";
import { type RunSummary, loadRun } from "./store.ts";
import type { ManagedTask, TaskManager } from "./tasks.ts";

const LIST_ROWS = 14;
const DETAIL_ROWS = 26;

interface Row {
	kind: "task" | "run";
	task?: ManagedTask;
	run?: RunSummary;
}

interface Theme {
	fg(color: any, text: string): string;
	bold(text: string): string;
}

function statusIcon(status: string, theme: Theme): string {
	switch (status) {
		case "ok":
		case "done":
			return theme.fg("success", "✓");
		case "running":
		case "queued":
			return theme.fg("warning", "⏳");
		case "timeout":
		case "max-turns":
			return theme.fg("error", "⏱");
		case "killed":
		case "aborted":
			return theme.fg("warning", "⚠");
		default:
			return theme.fg("error", "✗");
	}
}

function truncatePlain(text: string, max: number): string {
	return truncateToWidth(text.replace(/\s+/g, " "), Math.max(1, max));
}

export async function openDashboard(
	ctx: ExtensionCommandContext,
	tasks: TaskManager,
	historyProvider: () => RunSummary[],
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let rows: Row[] = [];
			let selected = 0;
			let listOffset = 0;
			let detailHeight = DETAIL_ROWS;
			let wrappedDetail: string[] = [];
			let view: "list" | "detail" = "list";
			let detailLines: string[] = [];
			let detailTitle = "";
			let detailOffset = 0;
			let cachedHistory: RunSummary[] = [];
			let historyFetchedAt = 0;

			const rebuild = () => {
				// History comes from disk; throttle re-reads.
				if (Date.now() - historyFetchedAt > 5000) {
					cachedHistory = historyProvider();
					historyFetchedAt = Date.now();
				}
				rows = [];
				for (const task of tasks.list().reverse()) rows.push({ kind: "task", task });
				for (const run of cachedHistory) rows.push({ kind: "run", run });
				if (selected >= rows.length) selected = Math.max(0, rows.length - 1);
			};
			rebuild();

			const timer = setInterval(() => {
				if (view === "list") {
					rebuild();
					tui.requestRender();
				}
			}, 1000);
			timer.unref?.();

			const close = () => {
				clearInterval(timer);
				done();
			};

			const taskDetail = (task: ManagedTask) => {
				const lines: string[] = [];
				lines.push(theme.fg("toolTitle", theme.bold(`${task.id} — ${task.label}`)));
				lines.push(
					`${statusIcon(task.status, theme)} ${theme.fg("muted", "status:")} ${task.status}  ` +
						`${theme.fg("muted", "kind:")} ${task.kind}  ` +
						`${theme.fg("muted", "elapsed:")} ${formatDuration((task.endedAt ?? Date.now()) - task.startedAt)}`,
				);
				const u = task.usage;
				lines.push(
					theme.fg(
						"dim",
						`usage: ${u.turns} turns ↑${formatTokens(u.input)} ↓${formatTokens(u.output)} $${u.cost.toFixed(4)}`,
					),
				);
				if (task.errorMessage) lines.push(theme.fg("error", `Error: ${task.errorMessage}`));
				lines.push(theme.fg("muted", "─── Output ───"));
				const text = task.result?.content.find((c) => c.type === "text");
				const output = text?.type === "text" ? text.text : task.summary;
				for (const line of output.split("\n")) lines.push(theme.fg("toolOutput", line));
				return lines;
			};

			const runDetail = (run: RunSummary) => {
				const lines: string[] = [];
				const stored = loadRun(run.file);
				lines.push(theme.fg("toolTitle", theme.bold(`${run.agent} — ${run.id}`)));
				lines.push(
					`${statusIcon(run.status, theme)} ${theme.fg("muted", "status:")} ${run.status}  ` +
						`${theme.fg("muted", "elapsed:")} ${formatDuration(run.durationMs)}  ` +
						`${theme.fg("muted", "cost:")} $${run.cost.toFixed(4)}` +
						(run.model ? `  ${theme.fg("muted", "model:")} ${run.model}` : ""),
				);
				lines.push(theme.fg("muted", `cwd: ${shortenPath(run.cwd)}`));
				if (stored?.worktree) {
					lines.push(theme.fg("muted", `worktree: ${shortenPath(stored.worktree.path)} (${stored.worktree.branch})`));
				}
				if (stored?.errorMessage) lines.push(theme.fg("error", `Error: ${stored.errorMessage}`));
				if (stored) {
					lines.push(theme.fg("muted", "─── Task ───"));
					for (const line of stored.task.split("\n")) lines.push(theme.fg("dim", line));
					lines.push(theme.fg("muted", "─── Final output ───"));
					for (const line of (stored.finalOutput || "(no output)").split("\n")) {
						lines.push(theme.fg("toolOutput", line));
					}
				} else {
					lines.push(theme.fg("error", "(run file could not be loaded)"));
				}
				return lines;
			};

			const openDetail = () => {
				const row = rows[selected];
				if (!row) return;
				if (row.kind === "task" && row.task) {
					detailTitle = row.task.id;
					detailLines = taskDetail(row.task);
				} else if (row.kind === "run" && row.run) {
					detailTitle = row.run.id;
					detailLines = runDetail(row.run);
				} else {
					return;
				}
				detailOffset = 0;
				view = "detail";
				tui.requestRender();
			};

			const renderList = (width: number): string[] => {
				const lines: string[] = [];
				const running = tasks.runningCount();
				const all = tasks.list();
				const cost = all.reduce((sum, t) => sum + t.usage.cost, 0);
				lines.push(
					theme.fg("toolTitle", theme.bold("Subagents ")) +
						theme.fg(
							"muted",
							`— ${running} running · ${all.length - running} settled this session · $${cost.toFixed(4)}`,
						),
				);
				lines.push("");

				if (rows.length === 0) {
					lines.push(theme.fg("dim", "No background tasks or run history yet."));
				}

				const count = Math.max(1, Math.min(LIST_ROWS, Math.floor((tui.terminal.rows * 0.85 - 7) / 2)));
				listOffset = Math.max(0, Math.min(listOffset, selected));
				if (selected >= listOffset + count) listOffset = selected - count + 1;
				const visible = rows.slice(listOffset, listOffset + count);
				for (let i = 0; i < visible.length; i++) {
					const row = visible[i];
					const isSelected = i + listOffset === selected;
					const cursor = isSelected ? theme.fg("accent", "›") : " ";
					let line: string;
					if (row.kind === "task" && row.task) {
						const t = row.task;
						line =
							`${cursor} ${statusIcon(t.status, theme)} ${theme.fg("accent", t.id.slice(0, 13))} ` +
							`${theme.fg("toolTitle", t.label.replace(/\s+/g, " "))} ` +
							theme.fg(
								"dim",
								`${t.status} ${formatDuration((t.endedAt ?? Date.now()) - t.startedAt)} $${t.usage.cost.toFixed(4)}`,
							);
						const preview = truncatePlain(summarizeOutput(t.summary, 60), Math.max(20, width - 10));
						line += `\n    ${theme.fg("dim", preview)}`;
					} else if (row.run) {
						const r = row.run;
						line =
							`${cursor} ${statusIcon(r.status, theme)} ${theme.fg("muted", "history ")} ` +
							`${theme.fg("toolTitle", r.agent)} ` +
							theme.fg("dim", `${r.status} ${formatDuration(r.durationMs)} $${r.cost.toFixed(4)}`);
						const preview = truncatePlain(r.task, Math.max(20, width - 10));
						line += `\n    ${theme.fg("dim", preview)}`;
					} else {
						continue;
					}
					lines.push(line);
				}
				if (rows.length > count) {
					lines.push(theme.fg("muted", `${listOffset + 1}–${listOffset + visible.length} of ${rows.length}`));
				}
				lines.push("");
				lines.push(theme.fg("muted", "↑/↓ select · enter details · k kill · r refresh · esc close"));
				return lines.flatMap((line) => line.split("\n")).map((line) => truncateToWidth(line, Math.max(1, width)));
			};

			const renderDetail = (width: number): string[] => {
				const lines: string[] = [];
				lines.push(theme.fg("toolTitle", theme.bold(detailTitle)));
				detailHeight = Math.max(1, Math.min(DETAIL_ROWS, Math.floor(tui.terminal.rows * 0.85 - 5)));
				wrappedDetail = detailLines.flatMap((line) =>
					line.split("\n").flatMap((part) => wrapTextWithAnsi(part, Math.max(1, width))),
				);
				const maxOffset = Math.max(0, wrappedDetail.length - detailHeight);
				detailOffset = Math.min(detailOffset, maxOffset);
				lines.push(...wrappedDetail.slice(detailOffset, detailOffset + detailHeight));
				if (wrappedDetail.length > detailHeight) {
					lines.push(
						theme.fg(
							"muted",
							`… ${detailOffset + 1}-${Math.min(detailOffset + detailHeight, wrappedDetail.length)} of ${wrappedDetail.length}`,
						),
					);
				}
				lines.push("");
				lines.push(theme.fg("muted", "↑/↓ scroll · pgup/pgdn page · esc back"));
				return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
			};

			const component: Component = {
				render(width: number): string[] {
					return view === "list" ? renderList(width) : renderDetail(width);
				},
				invalidate() {},
				handleInput(data: string) {
					if (view === "list") {
						if (matchesKey(data, "escape") || matchesKey(data, "q")) return close();
						if (matchesKey(data, "up")) {
							selected = Math.max(0, selected - 1);
						} else if (matchesKey(data, "down")) {
							selected = Math.min(rows.length - 1, selected + 1);
						} else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
							openDetail();
							return;
						} else if (data === "k") {
							const row = rows[selected];
							if (row?.kind === "task" && row.task) tasks.kill(row.task.id);
							rebuild();
						} else if (data === "r") {
							historyFetchedAt = 0;
							rebuild();
						} else {
							return;
						}
						tui.requestRender();
						return;
					}

					// detail view
					if (matchesKey(data, "escape") || matchesKey(data, "q")) {
						view = "list";
						rebuild();
					} else if (matchesKey(data, "up")) {
						detailOffset = Math.max(0, detailOffset - 1);
					} else if (matchesKey(data, "down")) {
						detailOffset = Math.min(Math.max(0, wrappedDetail.length - detailHeight), detailOffset + 1);
					} else if (matchesKey(data, "pageUp")) {
						detailOffset = Math.max(0, detailOffset - detailHeight);
					} else if (matchesKey(data, "pageDown")) {
						detailOffset = Math.min(Math.max(0, wrappedDetail.length - detailHeight), detailOffset + detailHeight);
					} else {
						return;
					}
					tui.requestRender();
				},
			};
			return component;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%", margin: 1 },
		},
	);
}
