/** Isolated CLI preload: fail the second post-run request-log read, never provider I/O. */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (file, ...args) {
	if (String(file) === process.env.MEASURE_TEST_REQUEST_LOG && ++reads === 2) {
		fs.writeFileSync(process.env.MEASURE_TEST_CONFIG_LOG, process.env.PI_CODING_AGENT_DIR, { mode: 0o600 });
		throw Object.assign(new Error("EACCES: injected measurement request-log read"), { code: "EACCES" });
	}
	return read.call(this, file, ...args);
};
syncBuiltinESMExports();
