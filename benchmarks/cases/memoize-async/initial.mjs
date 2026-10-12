export function memoizeAsync(fn) {
  const cache = new Map();
  return async (key) => {
    if (cache.get(key)) return cache.get(key);
    const value = await fn(key);
    cache.set(key, value);
    return value;
  };
}
