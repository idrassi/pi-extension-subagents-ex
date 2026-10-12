import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openDashboard } from "../src/dashboard.ts";
import { renderSubagentResult } from "../src/render.ts";
import { emptyUsage } from "../src/types.ts";

const theme = { fg: (_color: unknown, text: string) => text, bold: (text: string) => text };
test("dashboard emits physical lines within terminal width and scrolls selection into view", async () => {
	const tasks = Array.from({ length: 24 }, (_, i) => ({
		id: `task-${i}`,
		label: `label-${i} 日本語`,
		summary: "first\nsecond",
		usage: emptyUsage(),
		startedAt: Date.now(),
		status: "running",
		kind: "single",
	}));
	let closed = false;
	const ctx = {
		ui: {
			custom: async (factory: Function) => {
				const component = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, () => {
					closed = true;
				});
				try {
					for (const width of [8, 25, 80])
						for (const line of component.render(width)) {
							assert.ok(!line.includes("\n"));
							assert.ok(visibleWidth(line) <= width);
						}
					for (let i = 0; i < 20; i++) component.handleInput("\u001b[B");
					const selected = component.render(100).find((line: string) => line.startsWith("›"));
					assert.match(selected, /task-3/);
					component.handleInput("\r");
					for (const line of component.render(12)) {
						assert.ok(!line.includes("\n"));
						assert.ok(visibleWidth(line) <= 12);
					}
					component.handleInput("\u001b");
				} finally {
					component.handleInput("q");
				}
			},
		},
	};
	await openDashboard(ctx as any, { list: () => [...tasks], runningCount: () => tasks.length } as any, () => []);
	assert.ok(closed);
});

test("empty background result renders the task card", () => {
	const component = renderSubagentResult(
		{ content: [{ type: "text", text: "fallback" }], details: { mode: "background", taskId: "task-abc", results: [] } },
		{ expanded: false },
		theme,
	);
	assert.match(component.render(80).join("\n"), /Collect with subagent_task_output/);
});
