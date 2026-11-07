import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { mapLimit } = await import(pathToFileURL(`${process.env.EVAL_WORKSPACE}/lib.mjs`).href);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

async function check() {
  // Gates, not elapsed time, determine completion order and available slots.
  for (const limit of [1, 2, 8]) {
    const input = Object.freeze([17, 0, -9, 42]);
    const gates = input.map(deferred);
    const started = input.map(deferred);
    const running = new Set();
    const seen = [];
    const completed = [];
    let peak = 0;
    const result = mapLimit(input, limit, async (value, index) => {
      assert.ok(Number.isInteger(index) && index >= 0 && index < input.length);
      assert.equal(value, input[index], "callback must receive its own input value");
      assert.ok(!seen.includes(index), "each index is visited once");
      seen.push(index);
      running.add(index);
      peak = Math.max(peak, running.size);
      assert.ok(running.size <= limit, "concurrency exceeds limit");
      started[index].resolve();
      await gates[index].promise;
      running.delete(index);
      completed.push(index);
      return `${index}:${value * 3}`;
    });
    // Observe failures immediately even while waiting for a start notification.
    Promise.resolve(result).catch(() => {});
    const width = Math.min(limit, input.length);
    await Promise.race([Promise.all(started.slice(0, width).map((s) => s.promise)), result]);
    assert.equal(peak, width, "available slots should be filled");
    assert.deepEqual(seen, Array.from({ length: width }, (_, i) => i));
    let next = width;
    while (running.size) {
      const index = Math.max(...running);
      gates[index].resolve();
      if (next < input.length) {
        await Promise.race([started[next].promise, result]);
        assert.ok(seen.includes(next));
        next++;
      } else {
        // Drain the released callback without relying on wall-clock delays.
        await gates[index].promise;
        while (running.has(index)) await Promise.resolve();
      }
    }
    assert.deepEqual(await result, input.map((value, index) => `${index}:${value * 3}`));
    assert.equal(peak, width);
    if (limit > 1) assert.notDeepEqual(completed, [0, 1, 2, 3]);
  }
  assert.deepEqual(await mapLimit([], 1, () => { throw new Error("unreachable"); }), []);
  assert.deepEqual(await mapLimit(Object.freeze([4, 5]), 2, (value, index) => value + index), [4, 6]);
  for (const limit of [0, -1, 0.5, Infinity, -Infinity, NaN, "2", null, undefined, true]) {
    for (const items of [[], [1]]) {
      await assert.rejects(async () => mapLimit(items, limit, () => assert.fail("invalid limit invoked callback")));
    }
  }
  for (const asynchronous of [false, true]) {
    const failure = new Error("callback failed");
    await assert.rejects(async () => mapLimit([1, 2], 1, () => {
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    }), (error) => error === failure);
  }
}
let timer;
try {
  await Promise.race([check(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("mapLimit checker stalled waiting for a gate")), 3000);
  })]);
} finally {
  clearTimeout(timer);
}
