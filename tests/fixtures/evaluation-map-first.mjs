export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("invalid limit");
  let next = 0;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) { const i = next++; result[i] = await fn(items[0], i); }
  }));
  return result;
}
