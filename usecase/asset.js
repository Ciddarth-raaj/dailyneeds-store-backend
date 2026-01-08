const formidable = require("formidable");
const FileType = require("file-type");
const { uuid } = require("uuidv4");
const slug = require("slug");

const logger = require("../utils/logger");

const IMAGE = require("../services/image");
const S3 = require("../services/s3");

const ALLOWED_FILE_TYPES = {
  image: true,
  pdf: true,
};

const ALLOWED_FOLDERS = {
  products: true,
  products_t: true,
  categories: true,
  subcategories: true,
  departments: true,
  brands: true,
  promo: true,
  dashboard_file: true,
  receipts: true,
  employee_image: true,
  tickets: true,
};

class AssetUsecase {
  constructor() {}

  upload(req) {
    return new Promise((resolve, reject) => {
      const form = new formidable.IncomingForm();
      form.multiples = false;
      //5 MB
      form.maxFileSize = 10 * 1024 * 1024;
      form.parse(req, async (err, fields, files) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "USECASE",
            code: "USECASE.ASSET.UPLOAD",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }

        if (fields.name === undefined) {
          resolve({ code: 422, msg: "Asset name is required" });
          return;
        }

        if (fields.folder === undefined) {
          resolve({ code: 422, msg: "Asset folder is required" });
          return;
        }

        if (files.file === undefined || files.file.type === null) {
          resolve({ code: 422, msg: "Asset is required" });
          return;
        }

        if (!ALLOWED_FOLDERS[fields.folder]) {
          resolve({ code: 422, msg: "Invalid asset folder" });
          return;
        }

        const file = files.file;

        const { ext: fileExtenion, mime } = await FileType.fromFile(file.path);
        const fileType = IMAGE.getFileType(mime);

        if (!ALLOWED_FILE_TYPES[fileType]) {
          resolve({ code: 422, msg: "Invalid asset type" });
          return;
        }

        // actualName: optional param without UUID, used to create a stable file name
        // If provided, we overwrite any existing asset with the same key in S3.
        let baseName;
        if (fields.actualName && String(fields.actualName).trim() !== "") {
          // Strip any extension from actualName.
          // We keep underscores as-is and only normalise spaces and special chars.
          const rawActualName = String(fields.actualName).trim();
          const withoutExt = rawActualName.replace(/\.[^/.]+$/, "");
          // Normalise: lowercase, spaces -> '-', remove invalid chars except '_' and '-'
          baseName = withoutExt
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9_-]/g, "");
        } else {
          // Backwards-compatible: keep UUID-based unique name
          baseName = slug(fields.name) + "-" + uuid();
        }

        const fileName = fields.folder + "/" + baseName + "." + fileExtenion;

        try {
          if (fileExtenion != "webp" && fileExtenion != "pdf")
            await IMAGE.compress(file.path, file.path);
          const remoteUrl = await S3.uploadFile(file.path, fileName, mime);
          resolve({ code: 200, remoteUrl });
        } catch (err) {
          reject(err);
          console.log(err);
          return;
        }
      });
    });
  }

  /**
   * Delete an asset from S3 using its full URL.
   * This is used when product images are removed during update.
   */
  deleteByUrl(url) {
    return S3.deleteFileByUrl(url);
  }
}

module.exports = new AssetUsecase();
