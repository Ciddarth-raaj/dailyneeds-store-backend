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

module.exports = {
  uploadFile: uploadFile,
};
