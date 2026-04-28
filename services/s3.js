const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
const os = require("os");
const archiver = require("archiver");

const logger = require("../utils/logger");

const ID = "AKIAQODDYNWIRI3NI54P";
const SECRET = "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";
const BUCKET_NAME = "dailyneeds-assets-dev";

const FILE_PERMISSION = "public-read";

const s3 = new AWS.S3({
  accessKeyId: ID,
  secretAccessKey: SECRET,
});

const uploadFile = (filePath, fileName, contentType, fileData) => {
  return new Promise((resolve, reject) => {
    const file = filePath == undefined ? fileData : fs.readFileSync(filePath);

    const params = {
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: file,
      ContentType: contentType,
      ACL: FILE_PERMISSION,
    };

    s3.upload(params, (err, data) => {
      if (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE",
          code: "SERVICE.S3.UPLOAD",
          description: err.toString(),
          category: "",
          ref: {},
        });
        reject(err);
        return;
      }
      resolve(data.Location);
    });
  });
};

const deleteFileByKey = (key) => {
  return new Promise((resolve, reject) => {
    const params = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    s3.deleteObject(params, (err, data) => {
      if (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVICE",
          code: "SERVICE.S3.DELETE",
          description: err.toString(),
          category: "",
          ref: { key },
        });
        reject(err);
        return;
      }
      resolve(true);
    });
  });
};

const deleteFileByUrl = (url) => {
  return new Promise(async (resolve, reject) => {
    try {
      if (!url) {
        resolve(false);
        return;
      }

      // Support typical S3 URLs like:
      // https://bucket.s3.amazonaws.com/key or https://s3-region.amazonaws.com/bucket/key
      const parsed = new URL(url);
      let key = parsed.pathname.replace(/^\/+/, "");

      // If URL is of the form /bucket/key, strip bucket segment
      if (key.startsWith(`${BUCKET_NAME}/`)) {
        key = key.substring(BUCKET_NAME.length + 1);
      }

      if (!key) {
        resolve(false);
        return;
      }

      await deleteFileByKey(key);
      resolve(true);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE",
        code: "SERVICE.S3.DELETE.URL",
        description: err.toString(),
        category: "",
        ref: { url },
      });
      reject(err);
    }
  });
};

const normalizeFolderPrefix = (folderName) => {
  const raw = String(folderName == null ? "" : folderName).trim();
  const withoutLeadingSlash = raw.replace(/^\/+/, "");
  if (!withoutLeadingSlash) {
    throw new Error("folderName is required");
  }
  return withoutLeadingSlash.endsWith("/")
    ? withoutLeadingSlash
    : `${withoutLeadingSlash}/`;
};

const listAllObjectsByFolder = async (folderName, options = {}) => {
  const { onProgress } = options;
  const prefix = normalizeFolderPrefix(folderName);
  const objects = [];
  let continuationToken = undefined;
  let scannedPages = 0;

  do {
    const result = await s3
      .listObjectsV2({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
      .promise();

    const contents = (result && result.Contents ? result.Contents : []).filter(
      (item) => item && item.Key && !item.Key.endsWith("/")
    );
    objects.push(...contents);
    scannedPages += 1;
    if (typeof onProgress === "function") {
      onProgress({
        stage: "listing",
        listedFiles: objects.length,
        scannedPages,
        isFinalPage: !(result && result.IsTruncated),
      });
    }
    continuationToken =
      result && result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);

  return { prefix, objects };
};

const ensureDir = async (dirPath) => {
  await fs.promises.mkdir(dirPath, { recursive: true });
};

const removePathSafe = async (targetPath) => {
  if (!targetPath) return;
  try {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
  } catch (err) {
    logger.Log({
      level: logger.LEVEL.WARN,
      component: "SERVICE",
      code: "SERVICE.S3.CLEANUP_TMP",
      description: err.toString(),
      category: "",
      ref: { targetPath },
    });
  }
};

const toSafeRelativePath = (prefix, key) => {
  const normalizedPrefix = String(prefix || "").replace(/^\/+/, "");
  const normalizedKey = String(key || "").replace(/^\/+/, "");
  let relative = normalizedKey.startsWith(normalizedPrefix)
    ? normalizedKey.slice(normalizedPrefix.length)
    : normalizedKey;
  relative = relative.replace(/^\/+/, "").replace(/\\/g, "/").trim();
  relative = relative
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return relative;
};

const ensureNotCancelled = (options) => {
  if (typeof options.isCancelled === "function" && options.isCancelled()) {
    const cancelErr = new Error("Download cancelled");
    cancelErr.code = "DOWNLOAD_CANCELLED";
    throw cancelErr;
  }
};

const fileExistsWithSize = async (filePath, expectedSize) => {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    return Number(stat.size) === Number(expectedSize || 0);
  } catch (err) {
    return false;
  }
};

const zipDirectoryToFile = async (sourceDir, zipPath, options = {}) => {
  const zipRootFolder = String(options.zipRootFolder || "Images").trim() || "Images";
  const rawCompressionLevel = Number(options.compressionLevel);
  const compressionLevel = Math.max(
    0,
    Math.min(Number.isFinite(rawCompressionLevel) ? rawCompressionLevel : 0, 9)
  );
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", {
      forceZip64: true,
      store: compressionLevel === 0,
      zlib: { level: compressionLevel },
    });
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(sourceDir, zipRootFolder);
    archive.finalize();
  });
};

const createFolderZipInTmp = async (folderName, options = {}) => {
  const { onProgress } = options;
  const tmpRoot =
    options.tmpRoot || path.join(os.tmpdir(), "dailyneeds-downloads");
  const zipRootFolder =
    String(options.zipRootFolder || "Images").trim() || "Images";
  const downloadConcurrency = Math.max(
    1,
    Math.min(Number(options.downloadConcurrency) || 2, 4)
  );
  const rawCompressionLevel = Number(options.compressionLevel);
  const compressionLevel = Math.max(
    0,
    Math.min(Number.isFinite(rawCompressionLevel) ? rawCompressionLevel : 0, 9)
  );
  const { prefix, objects } = await listAllObjectsByFolder(folderName, {
    onProgress,
  });

  const totalFiles = objects.length;
  const totalBytes = objects.reduce(
    (sum, item) => sum + (Number(item.Size) || 0),
    0
  );

  const baseName = prefix.replace(/\/+$/, "").split("/").pop() || "files";
  const stamp = options.jobId
    ? String(options.jobId)
    : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workDir = options.workDir || path.join(tmpRoot, `${baseName}_${stamp}`);
  const extractedDir = path.join(workDir, "files");
  const zipPath = path.join(workDir, `${baseName}_${stamp}.zip`);

  await ensureDir(extractedDir);
  if (typeof onProgress === "function") {
    onProgress({
      stage: "downloading",
      tmpDir: workDir,
      totalFiles,
      downloadedFiles: 0,
      totalBytes,
      downloadedBytes: 0,
    });
  }

  let downloadedFiles = 0;
  let downloadedBytes = 0;
  try {
    let cursor = 0;
    const downloadOneObject = async (item) => {
      ensureNotCancelled(options);
      const normalizedRelativeKey = toSafeRelativePath(prefix, item.Key);
      const fileRelPath =
        normalizedRelativeKey && normalizedRelativeKey.length > 0
          ? normalizedRelativeKey
          : path.basename(item.Key);
      const localFile = path.join(extractedDir, fileRelPath);
      await ensureDir(path.dirname(localFile));
      const alreadyPresent = await fileExistsWithSize(localFile, item.Size);
      if (!alreadyPresent) {
        ensureNotCancelled(options);
        const readStream = s3
          .getObject({ Bucket: BUCKET_NAME, Key: item.Key })
          .createReadStream();
        const writeStream = fs.createWriteStream(localFile);
        await new Promise((res, rej) => {
          readStream.once("error", rej);
          writeStream.once("error", rej);
          writeStream.once("finish", res);
          readStream.pipe(writeStream);
        });
      }
      ensureNotCancelled(options);
      downloadedFiles += 1;
      downloadedBytes += Number(item.Size) || 0;
      if (typeof onProgress === "function") {
        onProgress({
          stage: "downloading",
          tmpDir: workDir,
          totalFiles,
          downloadedFiles,
          totalBytes,
          downloadedBytes,
          currentKey: item.Key,
        });
      }
    };

    const workerCount = Math.min(
      downloadConcurrency,
      Math.max(objects.length, 1)
    );
    const workers = Array.from({ length: workerCount }).map(async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= objects.length) break;
        await downloadOneObject(objects[index]);
      }
    });
    await Promise.all(workers);

    if (typeof onProgress === "function") {
      onProgress({
        stage: "zipping",
        tmpDir: workDir,
        totalFiles,
        downloadedFiles,
        totalBytes,
        downloadedBytes,
      });
    }

    ensureNotCancelled(options);
    await zipDirectoryToFile(extractedDir, zipPath, {
      zipRootFolder,
      compressionLevel,
    });
    await removePathSafe(extractedDir);

    if (typeof onProgress === "function") {
      onProgress({
        stage: "ready",
        tmpDir: workDir,
        totalFiles,
        downloadedFiles,
        totalBytes,
        downloadedBytes,
        zipPath,
      });
    }

    return {
      zipPath,
      tmpDir: workDir,
      fileName: path.basename(zipPath),
      totalFiles,
      totalBytes,
    };
  } catch (err) {
    await removePathSafe(workDir);
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "SERVICE",
      code: "SERVICE.S3.CREATE_FOLDER_ZIP_TMP",
      description: err.toString(),
      category: "",
      ref: { folderName: prefix },
    });
    throw err;
  }
};

module.exports = {
  uploadFile: uploadFile,
  deleteFileByKey: deleteFileByKey,
  deleteFileByUrl: deleteFileByUrl,
  createFolderZipInTmp: createFolderZipInTmp,
  removePathSafe: removePathSafe,
};
