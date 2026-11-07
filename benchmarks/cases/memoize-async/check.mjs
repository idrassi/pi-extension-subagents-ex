import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { memoizeAsync } = await import(pathToFileURL(`${process.env.EVAL_WORKSPACE}/lib.mjs`).href);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function check() {
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const cached = memoizeAsync((key) => {
    calls++;
    entered.resolve();
    return gate.promise.then(() => key === "zero" ? 0 : key);
  });
  const first = cached("zero");
  const second = cached("zero");
  await entered.promise;
  assert.equal(calls, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second, cached("other")]), [0, 0, "other"]);
  assert.equal(calls, 2);
  assert.equal(await cached("zero"), 0);
  assert.equal(calls, 2);

  // Failure occurs only after both callers have joined the in-flight operation.
  const rejectionGate = deferred();
  const rejectionEntered = deferred();
  const failure = new Error("asynchronous temporary failure");
  let asyncAttempts = 0;
  const asyncRetry = memoizeAsync(() => {
    if (++asyncAttempts === 1) {
      rejectionEntered.resolve();
      return rejectionGate.promise;
    }
    return "recovered";
  });
  const rejectedA = asyncRetry("retry");
  const rejectedB = asyncRetry("retry");
  const observedA = assert.rejects(rejectedA, (error) => error === failure);
  const observedB = assert.rejects(rejectedB, (error) => error === failure);
  await rejectionEntered.promise;
  assert.equal(asyncAttempts, 1);
  rejectionGate.reject(failure);
  await Promise.all([observedA, observedB]);
  assert.equal(await asyncRetry("retry"), "recovered");
  assert.equal(await asyncRetry("retry"), "recovered");
  assert.equal(asyncAttempts, 2);

  let attempts = 0;
  const retry = memoizeAsync(() => { if (++attempts === 1) throw new Error("temporary"); return false; });
  const failed = retry("x");
  assert.ok(failed instanceof Promise);
  await assert.rejects(failed, /temporary/);
  assert.equal(await retry("x"), false);
  assert.equal(await retry("x"), false);
  assert.equal(attempts, 2);

  const keys = [0, "0", false, "", null, undefined, NaN, 1n, Symbol("key"), Symbol("key")];
  const values = [false, 0, "", null, undefined, NaN, "bigint", "number", "symbol-a", "symbol-b"];
  const counts = new Map();
  const independent = memoizeAsync((key) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return values[keys.findIndex((candidate) => Object.is(candidate, key))];
  });
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(await Promise.all(keys.map((key) => {
      const pending = independent(key);
      assert.ok(pending instanceof Promise);
      return pending;
    })), values);
  }
  assert.equal(counts.size, keys.length);
  for (const count of counts.values()) assert.equal(count, 1);
}
let timer;
try {
  await Promise.race([check(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("memoizeAsync checker stalled waiting for a gate")), 3000);
  })]);
} finally {
  clearTimeout(timer);
}
