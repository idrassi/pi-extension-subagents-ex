export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (next < items.length) { const i = next++; result[i] = await fn(items[i], i); }
  }));
  return result;
}
