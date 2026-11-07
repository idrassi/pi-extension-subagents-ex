import Ajv from "ajv";

function compileOutputSchema(schema: Record<string, unknown>) {
	if (Buffer.byteLength(JSON.stringify(schema), "utf8") > 64 * 1024)
		throw new Error("outputSchema exceeds 64 KB");
	if (schema.$async === true) throw new Error("Async output schemas are not supported");

	// Each contract owns its registry: repeated/resumed calls may reuse any $id,
	// and schemas/validators must not accumulate for the lifetime of the extension.
	const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false });
	const validate = ajv.compile(schema);
	// Never invoke an async validator: its promise is truthy even for invalid data,
	// and a rejected promise would escape this synchronous API.
	if ("$async" in validate && validate.$async) throw new Error("Async output schemas are not supported");
	return { ajv, validate };
}

export function validateOutputSchema(schema: Record<string, unknown>): void {
	compileOutputSchema(schema);
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
		const { ajv, validate } = compileOutputSchema(schema);
		if (!validate(value)) throw new Error(`Output schema validation failed: ${ajv.errorsText(validate.errors)}`);
	}
	return value;
}
