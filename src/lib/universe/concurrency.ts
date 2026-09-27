// Bounded-concurrency helper for the one-request-per-candidate checks
// (historical data). Keeps a fixed number of lanes running, each pacing its
// own requests, instead of firing everything at once (AGENTS.md #33).

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  async function lane(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => lane()));
  return results;
}
