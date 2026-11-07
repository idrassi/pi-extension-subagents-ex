/** Offline streaming/delegation workload. Never contacts a provider or reads credentials. */
import * as fs from "node:fs";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function measurementProvider(pi: ExtensionAPI) {
	let sequence = 0;
	pi.registerProvider("subagents-measure", {
		api: "subagents-measure-api", baseUrl: "http://127.0.0.1/unused", apiKey: "offline-fixture",
		models: [{ id: "local", name: "Offline measurement stream", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const user = context.messages.filter((message) => message.role === "user").at(-1);
			const prompt = typeof user?.content === "string" ? user.content : user?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
			const delegate = prompt.includes("MEASURE_DELEGATE") && !context.messages.some((message) => message.role === "toolResult" && message.toolName === "subagent");
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: delegate ? [{ type: "toolCall", id: `delegate-${process.pid}-${sequence}`, name: "subagent",
					arguments: { agent: "measure-child", task: "MEASURE_CHILD", maxTurns: 2, notify: false } }] : [{ type: "text", text: "offline workload complete" }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
					cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
				stopReason: delegate ? "toolUse" : "stop", timestamp: Date.now() };
			const id = `${process.pid}-${sequence++}`;
			const log = (phase: "start" | "end") => {
				if (process.env.SUBAGENTS_MEASURE_REQUEST_LOG) fs.appendFileSync(process.env.SUBAGENTS_MEASURE_REQUEST_LOG,
					`${JSON.stringify({ id, phase, treeId: process.env.PI_SUBAGENTS_EX_TREE_ID, pid: process.pid, at: Date.now() })}\n`);
			};
			log("start");
			void (async () => {
				stream.push({ type: "start", partial: message });
				if (!delegate) stream.push({ type: "text_start", contentIndex: 0, partial: message });
				for (let i = 0; i < 8; i++) {
					await new Promise((resolve) => setTimeout(resolve, 40));
					if (options?.signal?.aborted) {
						message.stopReason = "aborted";
						log("end");
						stream.push({ type: "error", reason: "aborted", error: message });
						stream.end();
						return;
					}
					if (!delegate) stream.push({ type: "text_delta", contentIndex: 0, delta: ".", partial: message });
				}
				log("end");
				stream.push({ type: "done", reason: delegate ? "toolUse" : "stop", message });
				stream.end();
			})();
			return stream;
		},
	});
}
