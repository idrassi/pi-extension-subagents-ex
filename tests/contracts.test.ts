import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { validateOutput, validateOutputSchema } from "../src/contracts.ts";

test("JSON output accepts complete JSON values and rejects prose, fences, and trailing data", () => {
	for (const value of [null, true, false, 42, "answer", [1, "two"], { ok: true }])
		assert.deepEqual(validateOutput(` \n${JSON.stringify(value)}\t `), value);
	for (const text of ["", " ", "undefined", "Here: {}", "```json\n{}\n```", "{} prose", "{} {}", '{"ok":}'])
		assert.throws(() => validateOutput(text), /single valid JSON value/);
});

test("strict draft-07 contracts validate required fields, types, and additional properties", () => {
	const schema = {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		properties: {
			answer: { type: "integer", minimum: 1 },
			forbidden: false,
		},
		required: ["answer"],
		additionalProperties: false,
	};
	assert.doesNotThrow(() => validateOutputSchema(schema));
	assert.deepEqual(validateOutput('{"answer":42}', schema), { answer: 42 });
	for (const value of [{}, { answer: "42" }, { answer: 0 }, { answer: 1.5 }, { answer: 42, extra: true }, { answer: 42, forbidden: null }, null])
		assert.throws(() => validateOutput(JSON.stringify(value), schema), /Output schema validation failed:/);
});

test("both contract entry points reject invalid schemas and non-draft-07 keywords", () => {
	for (const schema of [
		{ type: "made-up" },
		{ type: "number", minimum: "zero" },
		{ type: "object", properties: { ok: { type: "made-up" } } },
		{ type: "object", properties: {}, required: ["missing"] },
		{ type: "string", misspelledKeyword: true },
		{ type: "object", unevaluatedProperties: false },
		{ $schema: "https://json-schema.org/draft/2020-12/schema", type: "string" },
	]) {
		assert.throws(() => validateOutputSchema(schema));
		assert.throws(() => validateOutput("null", schema));
	}
});

test("formats remain annotations, including unknown formats", () => {
	for (const format of ["email", "date-time", "not-a-registered-format"]) {
		const schema = { type: "string", format };
		assert.doesNotThrow(() => validateOutputSchema(schema));
		assert.equal(validateOutput('"not a formatted value"', schema), "not a formatted value");
		assert.throws(() => validateOutput("42", schema), /Output schema validation failed:/);
	}
});

test("async schemas are rejected before invalid output can produce an unhandled rejection", () => {
	const contractsUrl = new URL("../src/contracts.ts", import.meta.url).href;
	const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "--eval", `
		import assert from "node:assert/strict";
		import { validateOutput, validateOutputSchema } from ${JSON.stringify(contractsUrl)};
		for (const $async of [true, "enabled"]) {
			const schema = { $async, type: "number" };
			let validationError;
			try { validateOutput('"not a number"', schema); }
			catch (error) { validationError = error; }
			// Give a mistakenly invoked async validator time to reject. Strict mode
			// must not terminate the process, and validation must fail synchronously.
			await new Promise(setImmediate);
			assert.match(validationError?.message ?? "", /async/i);
			assert.throws(() => validateOutputSchema(schema), /async/i);
			assert.throws(() => validateOutput("42", schema), /async/i);
		}
		console.log("async schemas rejected synchronously");
	`], { encoding: "utf8", timeout: 5000 });
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.match(result.stdout, /async schemas rejected synchronously/);
});

test("nested async schemas cannot be used by a synchronous contract", () => {
	for (const schema of [
		{ type: "object", properties: { value: { $async: true, type: "number" } } },
		{ definitions: { value: { $async: true, type: "number" } }, $ref: "#/definitions/value" },
	]) {
		assert.throws(() => validateOutputSchema(schema), /async/i);
		assert.throws(() => validateOutput('{"value":"wrong"}', schema), /async/i);
	}
	const schema = { $async: false, type: "number" };
	assert.doesNotThrow(() => validateOutputSchema(schema));
	assert.equal(validateOutput("42", schema), 42);
	assert.throws(() => validateOutput('"wrong"', schema), /Output schema validation failed:/);
});

test("repeated contracts and saved/resumed copies may reuse the same $id", () => {
	const schema = {
		$id: "https://contracts.test/repeated",
		type: "object",
		definitions: { answer: { type: "integer" } },
		properties: { answer: { $ref: "#/definitions/answer" } },
		required: ["answer"],
		additionalProperties: false,
	};
	for (let i = 0; i < 4; i++) {
		const copy = JSON.parse(JSON.stringify(schema));
		assert.notEqual(copy, schema);
		assert.doesNotThrow(() => validateOutputSchema(copy));
		assert.deepEqual(validateOutput('{"answer":42}', JSON.parse(JSON.stringify(copy))), { answer: 42 });
		assert.throws(() => validateOutput('{"answer":"wrong"}', copy), /Output schema validation failed:/);
	}
});

test("independent contracts with conflicting root and nested $ids never share validators", () => {
	const contract = (type: string) => ({
		$id: "https://contracts.test/independent",
		type: "object",
		definitions: { value: { $id: "https://contracts.test/value", type } },
		properties: { value: { $ref: "https://contracts.test/value" } },
		required: ["value"],
		additionalProperties: false,
	});
	for (let i = 0; i < 3; i++) {
		for (const [type, value, invalid] of [["number", 42, "wrong"], ["string", "right", 42]] as const) {
			const schema = contract(type);
			assert.doesNotThrow(() => validateOutputSchema(schema));
			assert.deepEqual(validateOutput(JSON.stringify({ value }), schema), { value });
			assert.throws(() => validateOutput(JSON.stringify({ value: invalid }), schema), /Output schema validation failed:/);
		}
	}
});

test("a contract cannot resolve $refs against a previous contract's registry", () => {
	const $id = "https://contracts.test/not-shared";
	validateOutputSchema({ $id, type: "number" });
	assert.throws(() => validateOutputSchema({ $ref: $id }), /can't resolve reference/);
	assert.throws(() => validateOutput("42", { $ref: $id }), /can't resolve reference/);
});

test("reusing a mutated schema object validates its current content", () => {
	const schema = { $id: "https://contracts.test/mutated", type: "number" };
	validateOutputSchema(schema);
	assert.equal(validateOutput("42", schema), 42);
	schema.type = "string";
	validateOutputSchema(schema);
	assert.equal(validateOutput('"answer"', schema), "answer");
	assert.throws(() => validateOutput("42", schema), /Output schema validation failed:/);
});

test("both entry points enforce the inclusive 64 KiB UTF-8 schema size limit", () => {
	const limit = 64 * 1024;
	const schema = { type: "string", description: "" };
	schema.description = "a".repeat(limit - Buffer.byteLength(JSON.stringify(schema), "utf8"));
	assert.equal(Buffer.byteLength(JSON.stringify(schema), "utf8"), limit);
	assert.doesNotThrow(() => validateOutputSchema(schema));
	assert.equal(validateOutput('"ok"', schema), "ok");

	schema.description += "a";
	const unicodeSchema = { type: "string", description: "🎉".repeat(20_000) };
	assert.ok(JSON.stringify(unicodeSchema).length < limit);
	assert.ok(Buffer.byteLength(JSON.stringify(unicodeSchema), "utf8") > limit);
	for (const oversized of [schema, unicodeSchema]) {
		assert.throws(() => validateOutputSchema(oversized), /outputSchema exceeds 64 KB/);
		assert.throws(() => validateOutput('"ok"', oversized), /outputSchema exceeds 64 KB/);
	}
});
