/** Fresh-process recovery check: replay saved direct messages without duplicating event evidence. */
import { loadRunById, ARTIFACTS_DIR } from "../../src/store.ts";
import { VerificationCollector } from "../../src/verification.ts";
const run = loadRunById(process.argv[2]);
if (!run) throw new Error("Missing saved run");
const evidence = (run.attemptHistory ?? []).flatMap((attempt) => {
	const collector = new VerificationCollector({ runId: run.id, attempt: attempt.number, artifactDir: ARTIFACTS_DIR,
		cwd: run.cwd, evidence: attempt.verification });
	for (const message of attempt.messages) collector.observeMessage(message);
	collector.finish(attempt.status);
	return collector.evidence;
});
process.stdout.write(JSON.stringify(evidence));
