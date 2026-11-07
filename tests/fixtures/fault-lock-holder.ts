// Hold a real proper-lockfile transaction across an asynchronous IPC barrier.
import { withLock } from "../../src/files.ts";

let release!: () => void;
const barrier = new Promise<void>((resolve) => { release = resolve; });
process.once("message", (message) => {
	if (message !== "release") throw new Error(`Unexpected lock-holder message: ${message}`);
	release();
});
process.once("disconnect", () => release());
await withLock(process.argv[2], async () => {
	process.send!({ ready: true });
	await barrier;
});
process.disconnect();
