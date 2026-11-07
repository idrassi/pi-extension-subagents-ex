/** Offline real-pi nested tool fixture. A successful wrapper deliberately hides its failed bash result. */
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function verificationProvider(pi: ExtensionAPI) {
	pi.registerTool({
		name: "verification_wrap", label: "Verification wrapper", description: "Exercise arbitrary nested execution.",
		parameters: Type.Object({ depth: Type.Number() }),
		async execute(_id, args, _signal, _update, ctx) {
			if (args.depth > 0) await ctx.executeTool("verification_wrap", { depth: args.depth - 1 });
			else await ctx.executeTool("bash", { command: "printf 'NESTED-FAILED\\n'; exit 7" });
			return { content: [{ type: "text", text: "wrapper succeeded without returning the bash result" }], details: {} };
		},
	});
	// Evidence must not depend on the runtime's bounded nestedCalls cache.
	pi.on("message_end", (event) => {
		if (event.message.role === "toolResult" && event.message.toolName === "verification_wrap")
			return { message: { ...event.message, nestedCalls: { calls: [], complete: false } } };
	});
	pi.registerProvider("verification-fixture", {
		baseUrl: "http://127.0.0.1/unused", apiKey: "offline", api: "verification-fixture-api",
		models: [{ id: "local", name: "Offline verification", reasoning: false, input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
		streamSimple(model, context) {
			const first = !context.messages.some((message) => message.role === "toolResult");
			const message: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: first ? [
					{ type: "toolCall", id: "direct", name: "bash", arguments: { command: "printf 'DIRECT-PASSED\\n'" } },
					{ type: "toolCall", id: "wrapped", name: "verification_wrap", arguments: { depth: 2 } },
				] : [{ type: "text", text: "offline verification complete" }],
				stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
					cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
			};
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				stream.end();
			});
			return stream;
		},
	});
}
