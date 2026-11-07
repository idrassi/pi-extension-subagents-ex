import { Scheduler } from "../../src/scheduler.ts";

const [id, leaseId, mode] = process.argv.slice(2);
const scheduler = new Scheduler(id);
if (mode === "request-only") process.env.PI_SUBAGENTS_EX_LEASE_ID = leaseId;
else await scheduler.acquire(leaseId);
await scheduler.acquireRequest(mode === "request-only" ? `${leaseId}-attempt` : leaseId);
// Exit without cleanup: the next observer must prune the dead lease/request PID.
