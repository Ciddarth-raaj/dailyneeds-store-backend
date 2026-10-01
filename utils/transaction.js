const {
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("./batchInsert");

/**
 * Runs `work(conn)` inside one transaction on a connection taken from `pool`.
 *
 * Commits when `work` resolves, rolls back when it throws, and always hands
 * the connection back. Repositories take the `conn` as an optional last
 * argument, so the same method runs inside or outside a transaction.
 */
async function withTransaction(pool, work) {
  const conn = await getConnectionAsync(pool);
  try {
    await beginTransactionAsync(conn);
    const result = await work(conn);
    await commitAsync(conn);
    return result;
  } catch (err) {
    await rollbackAsync(conn);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { withTransaction };
