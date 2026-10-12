import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { mergeIntervals } = await import(pathToFileURL(`${process.env.EVAL_WORKSPACE}/lib.mjs`).href);
assert.deepEqual(mergeIntervals([]), []);
assert.deepEqual(mergeIntervals([[1, 10], [2, 3], [10, 12], [20, 21]]), [[1, 12], [20, 21]]);
const input = Object.freeze([Object.freeze([5, 8]), Object.freeze([1, 3]), Object.freeze([3, 5])]);
assert.deepEqual(mergeIntervals(input), [[1, 8]]);
