/**
 * Run an async mapper over `items` with at most `limit` in flight at a time.
 *
 * Repositories that split a big `WHERE ... IN (...)` lookup into chunks used to
 * fire every chunk at once. Both MySQL pools are capped at 10 connections
 * (drivers/mysql.js, drivers/mysql_gofrugal.js), so a 70-chunk fan-out would
 * take every connection and stall unrelated requests until it finished. Keeping
 * a few slots free costs the batch a little wall time and keeps the rest of the
 * API responsive.
 *
 * Results are returned in the same order as `items`. The first rejection wins;
 * once one call fails no further items are started, and calls already in flight
 * are allowed to settle but their results are dropped.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit max concurrent calls (values < 1 are treated as 1)
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return Promise.resolve([]);

  const max = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  const results = new Array(list.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (failed || index >= list.length) return;
      try {
        results[index] = await fn(list[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  return Promise.all(Array.from({ length: max }, worker)).then(() => results);
}

module.exports = { mapWithConcurrency };
