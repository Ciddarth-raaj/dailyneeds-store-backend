const logger = require("../utils/logger");

class ProductImageDownloadJobRepository {
  constructor(db) {
    this.db = db;
    this.ready = Promise.resolve();
  }

  async upsert(job) {
    await this.ready;
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO product_image_download_job (
          job_id, user_session, status, stage, folder, zip_root_folder, tmp_dir, zip_path, file_name,
          total_files, downloaded_files, total_bytes, downloaded_bytes, listed_files, scanned_pages,
          successful_downloads, max_downloads, cancelled, message, error, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          user_session = VALUES(user_session),
          status = VALUES(status),
          stage = VALUES(stage),
          folder = VALUES(folder),
          zip_root_folder = VALUES(zip_root_folder),
          tmp_dir = VALUES(tmp_dir),
          zip_path = VALUES(zip_path),
          file_name = VALUES(file_name),
          total_files = VALUES(total_files),
          downloaded_files = VALUES(downloaded_files),
          total_bytes = VALUES(total_bytes),
          downloaded_bytes = VALUES(downloaded_bytes),
          listed_files = VALUES(listed_files),
          scanned_pages = VALUES(scanned_pages),
          successful_downloads = VALUES(successful_downloads),
          max_downloads = VALUES(max_downloads),
          cancelled = VALUES(cancelled),
          message = VALUES(message),
          error = VALUES(error),
          started_at = VALUES(started_at),
          updated_at = VALUES(updated_at)
      `;
      const values = [
        job.id,
        job.userSession,
        job.status,
        job.stage || null,
        job.folder || null,
        job.zipRootFolder || null,
        job.tmpDir || null,
        job.zipPath || null,
        job.fileName || null,
        Number(job.totalFiles || 0),
        Number(job.downloadedFiles || 0),
        Number(job.totalBytes || 0),
        Number(job.downloadedBytes || 0),
        Number(job.listedFiles || 0),
        Number(job.scannedPages || 0),
        Number(job.successfulDownloads || 0),
        Number(job.maxDownloads || 3),
        job.cancelled ? 1 : 0,
        job.message || null,
        job.error || null,
        Number(job.startedAt || Date.now()),
        Number(job.updatedAt || Date.now()),
      ];
      this.db.query(sql, values, (err) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PRODUCT_IMAGE_DOWNLOAD_JOB",
            code: "REPOSITORY.PRODUCT_IMAGE_DOWNLOAD_JOB.UPSERT",
            description: err.toString(),
            category: "",
            ref: { jobId: job.id },
          });
          reject(err);
          return;
        }
        resolve(true);
      });
    });
  }

  async getByJobId(jobId) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM product_image_download_job WHERE job_id = ? LIMIT 1",
        [jobId],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }

  async getAllNotExpired(minUpdatedAt) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM product_image_download_job WHERE updated_at >= ?",
        [minUpdatedAt],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  async getByUserNotExpired(userSession, minUpdatedAt) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM product_image_download_job WHERE user_session = ? AND updated_at >= ? ORDER BY updated_at DESC",
        [userSession, minUpdatedAt],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows || []);
        }
      );
    });
  }

  async deleteOlderThan(minUpdatedAt) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM product_image_download_job WHERE updated_at < ?",
        [minUpdatedAt],
        (err, res) => {
          if (err) return reject(err);
          resolve({ affectedRows: res.affectedRows || 0 });
        }
      );
    });
  }

  async removeByJobId(jobId) {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM product_image_download_job WHERE job_id = ?",
        [jobId],
        (err) => {
          if (err) return reject(err);
          resolve(true);
        }
      );
    });
  }
}

module.exports = (db) => new ProductImageDownloadJobRepository(db);
