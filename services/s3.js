const AWS = require("aws-sdk");
const fs = require("fs");

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

module.exports = {
  uploadFile: uploadFile,
  deleteFileByKey: deleteFileByKey,
  deleteFileByUrl: deleteFileByUrl,
};
