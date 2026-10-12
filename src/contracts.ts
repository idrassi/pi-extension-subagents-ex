import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });

export function validateOutputSchema(schema: Record<string, unknown>): void {
	if (JSON.stringify(schema).length > 64 * 1024) throw new Error("outputSchema exceeds 64 KB");
	ajv.compile(schema);
}

/** Strict JSON: the complete final message must satisfy the requested contract. */
export function validateOutput(text: string, schema?: Record<string, unknown>): unknown {
	let value: unknown;
	try {
		value = JSON.parse(text.trim());
	} catch {
		throw new Error("Final output must be a single valid JSON value without prose or markdown fences");
	}
	if (schema) {
		const validate = ajv.compile(schema);
		if (!validate(value)) throw new Error(`Output schema validation failed: ${ajv.errorsText(validate.errors)}`);
	}
	return value;
}
