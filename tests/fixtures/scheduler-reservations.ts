import { Scheduler } from "../../src/scheduler.ts";
import * as fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [id, worker, log] = process.argv.slice(2);
const scheduler = new Scheduler(id);
const release = await scheduler.acquire(worker);
const record = (event: string) => fs.appendFileSync(log, `${JSON.stringify({ event, worker })}\n`);
record("worker-start");
try {
	const releaseRequest = await scheduler.acquireRequest(worker);
	const retryRelease = await scheduler.acquireRequest(worker);
	record("request-start");
	await delay(60); // Simulated streamed response, with no provider calls.
	record("request-end");
	await retryRelease();
	await releaseRequest();
	await delay(20); // Tool execution owns the worker/process, not a model request.
} finally {
	record("worker-end");
	await release();
}
