const DEFAULT_INSERT_BATCH_SIZE = 15000;

function queryAsync(connection, sql, params) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function getConnectionAsync(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) reject(err);
      else resolve(connection);
    });
  });
}

function beginTransactionAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.beginTransaction((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function commitAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.commit((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function rollbackAsync(connection) {
  return new Promise((resolve) => {
    connection.rollback(() => resolve());
  });
}

function insertRowsInBatches(
  connection,
  insertSql,
  rows,
  batchSize = DEFAULT_INSERT_BATCH_SIZE
) {
  return new Promise((resolve, reject) => {
    if (!rows || rows.length === 0) {
      resolve(0);
      return;
    }

    let index = 0;
    let inserted = 0;

    const runNext = () => {
      if (index >= rows.length) {
        resolve(inserted);
        return;
      }

      const chunk = rows.slice(index, index + batchSize);
      index += batchSize;
      inserted += chunk.length;

      connection.query(insertSql, [chunk], (err) => {
        if (err) {
          reject(err);
          return;
        }
        runNext();
      });
    };

    runNext();
  });
}

module.exports = {
  DEFAULT_INSERT_BATCH_SIZE,
  insertRowsInBatches,
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
};
