import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

export async function withLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	// Transactions are small snapshots. Recover locks left by SIGKILL promptly; retry
	// longer than the stale interval so cancellation cannot strand an execution slot.
	const release = await lockfile.lock(file, {
		realpath: false,
		stale: 2000,
		update: 1000,
		retries: { retries: 200, minTimeout: 10, maxTimeout: 100 },
	});
	try {
		return await fn();
	} finally {
		await release();
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
