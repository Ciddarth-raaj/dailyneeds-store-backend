const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");
const { REQUIRES_OTP_CODE } = require("../services/gst_authentication");

const GSTIN_PATTERN = /^[0-9A-Z]{15}$/;

class GstRoutes {
  constructor(gstUsecase) {
    this.gstUsecase = gstUsecase;
    this.init();
  }

  init() {
    router.get("/taxpayer/session", async (req, res) => {
      try {
        const payload = await this.gstUsecase.getTaxpayerSessionStatus();
        res.json(payload);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/taxpayer/session/check", async (req, res) => {
      try {
        const block = await this.gstUsecase.assertTaxpayerSessionForGstApis();
        if (block) {
          if (block.requires_gst_taxpayer_otp) {
            res.status(REQUIRES_OTP_CODE).json(block);
          } else {
            res.status(block.code === 503 ? 503 : 500).json(block);
          }
        } else {
          const st = await this.gstUsecase.getTaxpayerSessionStatus();
          res.json({
            code: 200,
            ok: true,
            session: st.session,
          });
        }
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/taxpayer/otp/request", async (req, res) => {
      try {
        const payload = await this.gstUsecase.requestTaxpayerOtp();
        const http =
          payload.axios_http_status != null ? payload.axios_http_status : 502;
        res.status(http).json(payload);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    const otpBodySchema = {
      otp: Joi.string().trim().regex(/^[0-9]{4,10}$/).required(),
    };

    router.post("/taxpayer/otp/verify", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, otpBodySchema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const payload = await this.gstUsecase.verifyTaxpayerOtp(
          isValid.value.otp
        );
        const http =
          payload.axios_http_status != null ? payload.axios_http_status : 502;
        res.status(http).json(payload);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/taxpayer/revalidate", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, otpBodySchema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const payload = await this.gstUsecase.revalidateTaxpayerWithOtp(
          isValid.value.otp
        );
        const http =
          payload.axios_http_status != null ? payload.axios_http_status : 502;
        res.status(http).json(payload);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/vendors", async (req, res) => {
      try {
        const payload = await this.gstUsecase.getAllVendors();
        res.json(payload);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/gstr-2a/b2b/:year/:month", async (req, res) => {
      try {
        const paramsSchema = {
          year: Joi.string()
            .trim()
            .regex(/^[0-9]{4}$/)
            .required(),
          month: Joi.string()
            .trim()
            .regex(/^(0[1-9]|1[0-2]|[1-9])$/)
            .required(),
        };
        const isValid = Joi.validate(req.params, paramsSchema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const result = await this.gstUsecase.getGstr2aB2bGroupedByVendors(
          isValid.value.year,
          isValid.value.month
        );

        if (result && result._block) {
          const b = result._block;
          if (b.requires_gst_taxpayer_otp) {
            res.status(REQUIRES_OTP_CODE).json(b);
          } else {
            res.status(b.code === 503 ? 503 : 500).json(b);
          }
        } else if (result && result.code != null && result.code !== 200) {
          const http =
            result.code === 422
              ? 422
              : result.code === 503
                ? 503
                : result.code >= 400 && result.code < 600
                  ? result.code
                  : 502;
          res.status(http).json(result);
        } else {
          res.json(result);
        }
      } catch (err) {
        if (err && err.gstOtpPayload) {
          res.status(REQUIRES_OTP_CODE).json(err.gstOtpPayload);
        } else {
          respondError(res, err);
        }
      }
      res.end();
    });

    router.post("/search", async (req, res) => {
      try {
        const schema = {
          gstin: Joi.string()
            .trim()
            .uppercase()
            .length(15)
            .regex(GSTIN_PATTERN)
            .required(),
        };

        const isValid = Joi.validate(
          {
            gstin: req.body.gstin,
          },
          schema
        );

        if (isValid.error !== null) {
          throw isValid.error;
        }

        const payload = await this.gstUsecase.searchGstin(isValid.value.gstin);

        res.json(payload);
      } catch (err) {
        respondError(res, err);
      }

      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (gstUsecase) => {
  return new GstRoutes(gstUsecase);
};
