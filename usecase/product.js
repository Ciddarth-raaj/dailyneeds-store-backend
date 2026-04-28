const AssetUsecase = require("./asset");
const fs = require("fs");
const path = require("path");
const S3 = require("../services/s3");

const PRODUCT_IMAGES_FOLDER = "products/image";
// const PRODUCT_IMAGES_FOLDER = "products_t/";
const DOWNLOAD_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const PRODUCT_IMAGE_DOWNLOAD_CONCURRENCY = 2;
const PRODUCT_IMAGE_ZIP_COMPRESSION_LEVEL = 0;
const DOWNLOAD_TMP_ROOT = path.join(process.cwd(), "tmp", "downloads");
const JOB_PROGRESS_DB_FLUSH_INTERVAL_MS = 60 * 1000;
let activeDownloadJob = null;
const downloadJobsById = new Map();
let bootstrapDone = false;

const now = () => Date.now();

const createUsecaseError = (message, statusCode, code, extra = {}) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
};


class ProductUsecase {
  constructor(productRepo, productImageLogUsecase, productImageDownloadJobRepo) {
    this.productRepo = productRepo;
    this.productImageLogUsecase = productImageLogUsecase;
    this.productImageDownloadJobRepo = productImageDownloadJobRepo;
  }
  updateProductDetails(product, createdBy) {
    return new Promise(async (resolve, reject) => {
      try {
        const product_id = product.product_id;

        let code = { code: 200 };

        // Update product details if provided
        if (product.product_details) {
          delete product.product_details.product_id;
          const result = await this.productRepo.updateProductDetails(
            product.product_details,
            product_id
          );
          code = result;
        }

        // Update images only when an images array was explicitly sent (not when key is missing/undefined)
        if (Array.isArray(product.images)) {
          const images = product.images;
          const existingImages =
            (await this.productRepo.getProductImages(product_id)) || [];

          const existingNormalized = existingImages
            .map((img) => ({ url: img.image_url, priority: img.priority || 0 }))
            .sort(
              (a, b) =>
                a.priority - b.priority ||
                (a.url || "").localeCompare(b.url || "")
            );
          const newNormalized = images
            .filter((img) => img && img.image_url)
            .map((img) => ({ url: img.image_url, priority: img.priority || 0 }))
            .sort(
              (a, b) =>
                a.priority - b.priority ||
                (a.url || "").localeCompare(b.url || "")
            );
          const same =
            existingNormalized.length === newNormalized.length &&
            existingNormalized.every(
              (e, i) =>
                e.url === newNormalized[i].url &&
                e.priority === newNormalized[i].priority
            );

          if (!same) {
            const newImageUrls = new Set(
              images
                .filter((img) => img && img.image_url)
                .map((img) => img.image_url)
            );
            for (const img of existingImages) {
              if (img.image_url && !newImageUrls.has(img.image_url)) {
                try {
                  await AssetUsecase.deleteByUrl(img.image_url);
                } catch (e) {
                  console.error(
                    "Failed to delete image from S3:",
                    img.image_url,
                    e.toString()
                  );
                }
              }
            }
            await this.productRepo.deleteProductImages(product_id);
            if (images.length > 0) {
              await this.productRepo.createProductImages(product_id, images);
            }
            const existingUrls = new Set(
              (existingImages || []).map((i) => i.image_url).filter(Boolean)
            );
            const newUrls = new Set(
              images.filter((i) => i && i.image_url).map((i) => i.image_url)
            );
            const urlsChanged =
              existingUrls.size !== newUrls.size ||
              [...newUrls].some((u) => !existingUrls.has(u));
            if (
              images.length > 0 &&
              urlsChanged &&
              this.productImageLogUsecase
            ) {
              try {
                await this.productImageLogUsecase.logImageUpdate(
                  product_id,
                  images,
                  createdBy
                );
              } catch (e) {
                console.error("Failed to log product image update:", e);
              }
            }
          }
        }

        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
  }
  getAllProductData() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getAllProductData();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getProductById(product_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getProductById(product_id);
        if (data && data.length > 0) {
          const product = data[0];
          const images = await this.productRepo.getProductImages(product_id);
          product.images = images || [];
        }
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getProductByFilter(filter, limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getProductByFilter(
          filter,
          limit,
          offset
        );
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getProductCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getProductCount();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  get(limit, offset, fetchAll = false) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.get(limit, offset, fetchAll);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  create(product, createdBy) {
    return new Promise(async (resolve, reject) => {
      try {
        const productData = { ...product };
        delete productData.images;

        const code = await this.productRepo.create(productData);

        // Only touch images when an images array was explicitly sent (sync often omits images)
        if (
          (code.code === 200 || code.code === 101) &&
          Array.isArray(product.images)
        ) {
          const images = product.images;
          const productId = product.product_id || code.id;
          if (productId) {
            const existingImages =
              (await this.productRepo.getProductImages(productId)) || [];
            const existingNormalized = existingImages
              .map((img) => ({
                url: img.image_url,
                priority: img.priority || 0,
              }))
              .sort(
                (a, b) =>
                  a.priority - b.priority ||
                  (a.url || "").localeCompare(b.url || "")
              );
            const newNormalized = images
              .filter((img) => img && img.image_url)
              .map((img) => ({
                url: img.image_url,
                priority: img.priority || 0,
              }))
              .sort(
                (a, b) =>
                  a.priority - b.priority ||
                  (a.url || "").localeCompare(b.url || "")
              );
            const same =
              existingNormalized.length === newNormalized.length &&
              existingNormalized.every(
                (e, i) =>
                  e.url === newNormalized[i].url &&
                  e.priority === newNormalized[i].priority
              );

            if (!same) {
              await this.productRepo.deleteProductImages(productId);
              if (images.length > 0) {
                await this.productRepo.createProductImages(productId, images);
              }
              const existingUrls = new Set(
                (existingImages || []).map((i) => i.image_url).filter(Boolean)
              );
              const newUrls = new Set(
                images.filter((i) => i && i.image_url).map((i) => i.image_url)
              );
              const urlsChanged =
                existingUrls.size !== newUrls.size ||
                [...newUrls].some((u) => !existingUrls.has(u));
              if (
                images.length > 0 &&
                urlsChanged &&
                this.productImageLogUsecase
              ) {
                try {
                  await this.productImageLogUsecase.logImageUpdate(
                    productId,
                    images,
                    createdBy
                  );
                } catch (e) {
                  console.error("Failed to log product image create:", e);
                }
              }
            }
          }
        }

        resolve(code);
      } catch (err) {
        reject(err);
        console.log(err);
      }
    });
  }

  getDownloadSessionKey(decoded) {
    const employeeId = decoded && decoded.employee_id;
    const userId = decoded && decoded.user_id;
    return String(employeeId || userId || "anonymous");
  }

  createDownloadProgressSnapshot(job) {
    const filesPercent =
      job.totalFiles > 0
        ? Math.min(
            100,
            Math.round((job.downloadedFiles / job.totalFiles) * 100)
          )
        : 0;
    const bytesPercent =
      job.totalBytes > 0
        ? Math.min(
            100,
            Math.round((job.downloadedBytes / job.totalBytes) * 100)
          )
        : 0;

    return {
      job_id: job.id,
      status: job.status,
      folder: job.folder,
      started_at: job.startedAt,
      updated_at: job.updatedAt,
      total_files: job.totalFiles,
      downloaded_files: job.downloadedFiles,
      total_bytes: job.totalBytes,
      downloaded_bytes: job.downloadedBytes,
      files_percent: filesPercent,
      bytes_percent: bytesPercent,
      listed_files: job.listedFiles || 0,
      scanned_pages: job.scannedPages || 0,
      successful_downloads: job.successfulDownloads || 0,
      stage: job.stage || "queued",
      message: job.message || "",
      ready: job.status === "ready",
      download_url:
        job.status === "ready"
          ? `/product/images/download/file?jobId=${job.id}`
          : null,
    };
  }

  hydrateJobFromStoreRow(row) {
    if (!row) return null;
    return {
      id: row.job_id,
      userSession: row.user_session,
      status: row.status,
      stage: row.stage || "queued",
      folder: row.folder || PRODUCT_IMAGES_FOLDER,
      zipRootFolder: row.zip_root_folder || "Images",
      tmpDir: row.tmp_dir || null,
      zipPath: row.zip_path || null,
      fileName: row.file_name || null,
      totalFiles: Number(row.total_files || 0),
      downloadedFiles: Number(row.downloaded_files || 0),
      totalBytes: Number(row.total_bytes || 0),
      downloadedBytes: Number(row.downloaded_bytes || 0),
      listedFiles: Number(row.listed_files || 0),
      scannedPages: Number(row.scanned_pages || 0),
      successfulDownloads: Number(row.successful_downloads || 0),
      cancelled: Boolean(row.cancelled),
      message: row.message || "",
      error: row.error || null,
      startedAt: Number(row.started_at || Date.now()),
      updatedAt: Number(row.updated_at || Date.now()),
      lastPersistedAt: Number(row.updated_at || 0),
    };
  }

  async persistJob(job, options = {}) {
    if (!job) return;
    const force = Boolean(options.force);
    const currentTs = now();
    const lastPersistedAt = Number(job.lastPersistedAt || 0);
    if (!force && currentTs - lastPersistedAt < JOB_PROGRESS_DB_FLUSH_INTERVAL_MS) {
      return;
    }
    if (
      this.productImageDownloadJobRepo &&
      typeof this.productImageDownloadJobRepo.upsert === "function"
    ) {
      await this.productImageDownloadJobRepo.upsert(job);
      job.lastPersistedAt = currentTs;
    }
  }

  async removePersistedJob(jobId) {
    if (!jobId) return;
    if (
      this.productImageDownloadJobRepo &&
      typeof this.productImageDownloadJobRepo.removeByJobId === "function"
    ) {
      await this.productImageDownloadJobRepo.removeByJobId(jobId);
    }
  }

  startOrResumeDownloadWorker(job) {
    if (!job) return;
    activeDownloadJob = job;
    downloadJobsById.set(job.id, job);
    const tempRoot = DOWNLOAD_TMP_ROOT;
    const persistProgress = async () => {
      job.updatedAt = now();
      await this.persistJob(job, { force: true });
    };

    S3.createFolderZipInTmp(PRODUCT_IMAGES_FOLDER, {
      tmpRoot: tempRoot,
      workDir: job.tmpDir || undefined,
      jobId: job.id,
      zipRootFolder: job.zipRootFolder,
      downloadConcurrency: PRODUCT_IMAGE_DOWNLOAD_CONCURRENCY,
      compressionLevel: PRODUCT_IMAGE_ZIP_COMPRESSION_LEVEL,
      isCancelled: () => Boolean(job.cancelled),
      onProgress: (progress) => {
        job.stage = progress.stage || job.stage;
        job.totalFiles = Number(progress.totalFiles || job.totalFiles || 0);
        job.downloadedFiles = Number(
          progress.downloadedFiles || job.downloadedFiles || 0
        );
        job.totalBytes = Number(progress.totalBytes || job.totalBytes || 0);
        job.downloadedBytes = Number(
          progress.downloadedBytes || job.downloadedBytes || 0
        );
        if (progress.tmpDir) {
          job.tmpDir = progress.tmpDir;
        }
        job.listedFiles = Number(progress.listedFiles || job.listedFiles || 0);
        job.scannedPages = Number(progress.scannedPages || job.scannedPages || 0);
        job.updatedAt = now();
        if (progress.stage === "listing") {
          job.message = `Preparing file list (${job.listedFiles} found so far)`;
        } else if (progress.stage === "downloading") {
          job.message = `Downloading files (${job.downloadedFiles}/${job.totalFiles})`;
        } else if (progress.stage === "zipping") {
          job.message = "Creating zip archive";
        } else if (progress.stage === "ready") {
          job.message = "Archive is ready";
        }
        this.persistJob(job).catch(() => {});
      },
    })
      .then(async (result) => {
        job.status = "ready";
        job.stage = "ready";
        job.updatedAt = now();
        job.fileName = result.fileName;
        job.zipPath = result.zipPath;
        job.tmpDir = result.tmpDir;
        job.totalFiles = result.totalFiles;
        job.totalBytes = result.totalBytes;
        await persistProgress();
      })
      .catch(async (err) => {
        if (err && err.code === "DOWNLOAD_CANCELLED") {
          job.status = "cancelled";
          job.stage = "cancelled";
          job.updatedAt = now();
          job.message = "Download was cancelled";
          if (job.tmpDir) {
            await S3.removePathSafe(job.tmpDir);
            job.tmpDir = null;
          }
          downloadJobsById.delete(job.id);
          await this.removePersistedJob(job.id);
          return;
        }
        job.status = "failed";
        job.stage = "failed";
        job.updatedAt = now();
        job.error = err.message || err.toString();
        job.message = "Failed to generate archive";
        if (job.tmpDir) {
          await S3.removePathSafe(job.tmpDir);
        }
        await persistProgress();
      })
      .finally(() => {
        if (activeDownloadJob && activeDownloadJob.id === job.id) {
          activeDownloadJob = null;
        }
      });
  }

  async bootstrapDownloadJobsFromStore() {
    if (bootstrapDone) return;
    bootstrapDone = true;
    if (
      !this.productImageDownloadJobRepo ||
      typeof this.productImageDownloadJobRepo.getAllNotExpired !== "function"
    ) {
      return;
    }
    const minUpdatedAt = now() - DOWNLOAD_JOB_TTL_MS;
    const rows = await this.productImageDownloadJobRepo.getAllNotExpired(minUpdatedAt);
    for (const row of rows || []) {
      const job = this.hydrateJobFromStoreRow(row);
      if (!job) continue;
      downloadJobsById.set(job.id, job);
      if (job.status === "in_progress") {
        this.startOrResumeDownloadWorker(job);
      } else if (activeDownloadJob == null && job.status === "ready") {
        // keep latest ready job discoverable in memory.
        activeDownloadJob = null;
      }
    }
  }

  async cleanupExpiredDownloadJobs() {
    await this.bootstrapDownloadJobsFromStore();
    const ts = now();
    const minUpdatedAt = ts - DOWNLOAD_JOB_TTL_MS;
    if (
      this.productImageDownloadJobRepo &&
      typeof this.productImageDownloadJobRepo.deleteOlderThan === "function"
    ) {
      await this.productImageDownloadJobRepo.deleteOlderThan(minUpdatedAt);
    }
    const ids = Array.from(downloadJobsById.keys());
    for (const id of ids) {
      const job = downloadJobsById.get(id);
      if (!job) continue;
      if (job.status === "in_progress") continue;
      if (ts - job.updatedAt < DOWNLOAD_JOB_TTL_MS) continue;
      if (job.tmpDir) {
        await S3.removePathSafe(job.tmpDir);
      }
      downloadJobsById.delete(id);
      await this.removePersistedJob(id);
      if (activeDownloadJob && activeDownloadJob.id === id) {
        activeDownloadJob = null;
      }
    }
  }

  async startProductImagesDownload(sessionKey, options = {}) {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();

    const existingUserJob = Array.from(downloadJobsById.values()).find(
      (j) => j.userSession === sessionKey && j.status === "in_progress"
    );
    if (existingUserJob) {
      return {
        code: 202,
        message: "Download already in progress for this session",
        progress: this.createDownloadProgressSnapshot(existingUserJob),
      };
    }

    if (activeDownloadJob && activeDownloadJob.status === "in_progress") {
      throw createUsecaseError(
        "Another download is currently in progress. Try again shortly.",
        409,
        "DOWNLOAD_IN_PROGRESS",
        { active_job_id: activeDownloadJob.id }
      );
    }

    const jobId = `imgzip_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const tempRoot = DOWNLOAD_TMP_ROOT;
    const job = {
      id: jobId,
      status: "in_progress",
      stage: "listing",
      folder: PRODUCT_IMAGES_FOLDER,
      zipRootFolder: options.zipRootFolder || "Images",
      userSession: sessionKey,
      startedAt: now(),
      updatedAt: now(),
      totalFiles: 0,
      downloadedFiles: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      listedFiles: 0,
      scannedPages: 0,
      fileName: null,
      zipPath: null,
      tmpDir: null,
      cancelled: false,
      successfulDownloads: 0,
      message: "Preparing file list",
      error: null,
    };

    activeDownloadJob = job;
    downloadJobsById.set(jobId, job);
    await this.persistJob(job, { force: true });
    this.startOrResumeDownloadWorker(job);

    return {
      code: 202,
      message: "Download started",
      progress: this.createDownloadProgressSnapshot(job),
    };
  }

  async cancelProductImagesDownload(jobId, sessionKey) {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();
    const job = downloadJobsById.get(jobId);
    if (!job) {
      throw createUsecaseError(
        "Download job not found or expired",
        404,
        "JOB_NOT_FOUND"
      );
    }
    if (job.userSession !== sessionKey) {
      throw createUsecaseError("Forbidden", 403, "FORBIDDEN");
    }
    if (job.status !== "in_progress") {
      throw createUsecaseError(
        "Only in-progress jobs can be cancelled",
        409,
        "JOB_NOT_CANCELLABLE",
        { progress: this.createDownloadProgressSnapshot(job) }
      );
    }

    job.cancelled = true;
    job.status = "cancelled";
    job.stage = "cancelled";
    job.updatedAt = now();
    job.message = "Cancelling download...";
    if (job.tmpDir) {
      await S3.removePathSafe(job.tmpDir);
      job.tmpDir = null;
    }
    downloadJobsById.delete(job.id);
    if (activeDownloadJob && activeDownloadJob.id === job.id) {
      activeDownloadJob = null;
    }
    await this.removePersistedJob(job.id);

    return {
      code: 202,
      message: "Download cancellation requested",
      progress: this.createDownloadProgressSnapshot(job),
    };
  }

  async getProductImagesDownloadStatus(jobId, sessionKey) {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();
    const job = downloadJobsById.get(jobId);
    if (!job) {
      throw createUsecaseError(
        "Download job not found or expired",
        404,
        "JOB_NOT_FOUND"
      );
    }
    if (job.userSession !== sessionKey) {
      throw createUsecaseError("Forbidden", 403, "FORBIDDEN");
    }

    return {
      code: 200,
      progress: this.createDownloadProgressSnapshot(job),
      error: job.error || null,
    };
  }

  async getActiveProductImagesDownloadJob(sessionKey) {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();
    const activeForUser = Array.from(downloadJobsById.values()).find(
      (job) => job.userSession === sessionKey && job.status === "in_progress"
    );
    if (!activeForUser) {
      return {
        code: 200,
        has_active_job: false,
        job_id: null,
        progress: null,
      };
    }

    return {
      code: 200,
      has_active_job: true,
      job_id: activeForUser.id,
      progress: this.createDownloadProgressSnapshot(activeForUser),
    };
  }

  async listProductImagesDownloads(sessionKey) {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();
    const minUpdatedAt = now() - DOWNLOAD_JOB_TTL_MS;

    if (
      this.productImageDownloadJobRepo &&
      typeof this.productImageDownloadJobRepo.getAllNotExpired === "function"
    ) {
      const rows = await this.productImageDownloadJobRepo.getAllNotExpired(
        minUpdatedAt
      );
      return {
        code: 200,
        downloads: (rows || []).map((row) =>
          this.createDownloadProgressSnapshot(this.hydrateJobFromStoreRow(row))
        ),
      };
    }

    const jobs = Array.from(downloadJobsById.values())
      .filter((job) => now() - Number(job.updatedAt || 0) < DOWNLOAD_JOB_TTL_MS)
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
      .map((job) => this.createDownloadProgressSnapshot(job));
    return {
      code: 200,
      downloads: jobs,
    };
  }

  async getProductImagesDownloadFile(jobId, sessionKey) {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();
    const job = downloadJobsById.get(jobId);
    if (!job) {
      throw createUsecaseError(
        "Download job not found or expired",
        404,
        "JOB_NOT_FOUND"
      );
    }
    if (job.userSession !== sessionKey) {
      throw createUsecaseError("Forbidden", 403, "FORBIDDEN");
    }
    if (job.status !== "ready" || !job.zipPath) {
      throw createUsecaseError(
        "File is not ready yet. Poll status endpoint.",
        409,
        "JOB_NOT_READY",
        { progress: this.createDownloadProgressSnapshot(job) }
      );
    }

    return {
      zipPath: job.zipPath,
      fileName: job.fileName || "products_images.zip",
      jobId: job.id,
    };
  }

  async finalizeProductImagesDownload(jobId, wasSuccessful = true) {
    await this.bootstrapDownloadJobsFromStore();
    const job = downloadJobsById.get(jobId);
    if (!job) return;

    if (wasSuccessful) {
      job.successfulDownloads = Number(job.successfulDownloads || 0) + 1;
      job.updatedAt = now();
      job.message = `Archive downloaded ${job.successfulDownloads} time(s)`;
      await this.persistJob(job, { force: true });
    }
  }

  async cleanupDownloadTmpDirectoryKeepingActiveJobs() {
    await this.bootstrapDownloadJobsFromStore();
    await this.cleanupExpiredDownloadJobs();
    let entries = [];
    try {
      entries = await fs.promises.readdir(DOWNLOAD_TMP_ROOT, {
        withFileTypes: true,
      });
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return {
          code: 200,
          message: "Download tmp directory not found; nothing to clean",
          cleaned_count: 0,
          kept_count: 0,
        };
      }
      throw err;
    }

    const keepPaths = new Set(
      Array.from(downloadJobsById.values())
        .filter((job) => job && job.status === "in_progress" && job.tmpDir)
        .map((job) => path.resolve(job.tmpDir))
    );

    let cleanedCount = 0;
    let keptCount = 0;
    for (const entry of entries) {
      const entryPath = path.resolve(path.join(DOWNLOAD_TMP_ROOT, entry.name));
      if (keepPaths.has(entryPath)) {
        keptCount += 1;
        continue;
      }
      const linkedJob = Array.from(downloadJobsById.values()).find(
        (job) => job && job.tmpDir && path.resolve(job.tmpDir) === entryPath
      );
      await S3.removePathSafe(entryPath);
      if (linkedJob) {
        downloadJobsById.delete(linkedJob.id);
        await this.removePersistedJob(linkedJob.id);
      }
      cleanedCount += 1;
    }

    return {
      code: 200,
      message: "Download tmp cleanup completed",
      cleaned_count: cleanedCount,
      kept_count: keptCount,
    };
  }
}

module.exports = (productRepo, productImageLogUsecase, productImageDownloadJobRepo) => {
  return new ProductUsecase(
    productRepo,
    productImageLogUsecase,
    productImageDownloadJobRepo
  );
};
