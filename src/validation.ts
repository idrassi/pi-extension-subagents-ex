/** Shared validation for frontmatter, tool arguments, and the process engine. */
export const MAX_TIMEOUT_SECONDS = 2_147_483;
export const MAX_RETRIES = 3;
export const MAX_PARALLEL_TASKS = 32;
export const MAX_CHAIN_STEPS = 32;
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

export function numberControl(
	value: unknown,
	name: string,
	min: number,
	max: number,
	integer = false,
): number | undefined {
	if (value === undefined) return undefined;
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
		throw new Error(`${name} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}`);
	}
	return n;
}

export function validateControls(values: {
	timeoutSeconds?: number;
	maxTurns?: number;
	retries?: number;
	maxCost?: number;
}): void {
	for (const [name, value] of Object.entries(values)) {
		if (
			["timeoutSeconds", "maxTurns", "retries", "maxCost"].includes(name) &&
			value !== undefined &&
			typeof value !== "number"
		)
			throw new Error(`${name} must be a number`);
	}
	numberControl(values.timeoutSeconds, "timeout", 0.001, MAX_TIMEOUT_SECONDS);
	numberControl(values.maxTurns, "maxTurns", 1, 100_000, true);
	numberControl(values.retries, "retries", 0, MAX_RETRIES, true);
	numberControl(values.maxCost, "maxCost", 0.000001, 1_000_000);
}

export function validatePrompt(task: string): void {
	if (typeof task !== "string" || !task.trim()) throw new Error("Task must be a non-empty string");
	if (Buffer.byteLength(task, "utf8") > MAX_PROMPT_BYTES)
		throw new Error(`Task exceeds ${MAX_PROMPT_BYTES} bytes; use artifact references for large handoffs`);
}
