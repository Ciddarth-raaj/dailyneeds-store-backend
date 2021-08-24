const Jimp = require("jimp");

const logger = require("../utils/logger");

module.exports = {
  compress: (source, destination) => {
    return new Promise((resolve, reject) => {
      Jimp.read(source, (err, image) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVICE",
            code: "SERVICE.JIMP.COMPRESS-READ",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        image
          .resize(Jimp.AUTO, 750)
          .quality(85)
          .write(destination, (err) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "SERVICE",
                code: "SERVICE.JIMP.COMPRESS",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }
            resolve();
          });
      });
    });
  },

  getFileType: (mimeType) => {
    if (mimeType.startsWith("image")) {
      return "image";
    } else if (mimeType.startsWith("video") && !mimeType.endsWith("wmv")) {
      return "video";
    } else if (mimeType == "application/pdf") {
      return "pdf";
    } else if (mimeType.startsWith("audio")) {
      return "audio";
    } else if (mimeType === "application/x-shockwave-flash") {
      return "flash";
    } else if (mimeType.startsWith("application/vnd")) {
      return "office";
    } else if (
      mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) {
      return "ppt";
    } else if (
      mimeType === "application/zip" ||
      mimeType === "application/x-zip-compressed"
    ) {
      return "exe";
    } else {
      return null;
    }
  },
};
