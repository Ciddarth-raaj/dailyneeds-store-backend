const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

function getActingUser(req) {
  return req.decoded && req.decoded.employee_id ? req.decoded.employee_id : null;
}

function sendResult(res, result) {
  if (result && result.code === 400) {
    res.status(400).json(result);
  } else if (result && result.code === 404) {
    res.status(404).json(result);
  } else {
    res.json(result);
  }
}

const groupSchema = Joi.object({
  label: Joi.string().required(),
  group_type: Joi.string().valid("brand", "individual").optional(),
  supplier: Joi.string().allow("", null).optional(),
  markdown_pct: Joi.number().allow(null).optional(),
  talker_text: Joi.string().allow("", null).optional(),
  expected_price: Joi.number().allow(null).optional(),
  expected_pct_off: Joi.number().allow(null).optional(),
  active_from: Joi.string().allow("", null).optional(),
  active_to: Joi.string().allow("", null).optional(),
  item_codes: Joi.array().items(Joi.number().integer()).optional(),
});

const groupUpdateSchema = Joi.object({
  label: Joi.string().optional(),
  group_type: Joi.string().valid("brand", "individual").optional(),
  supplier: Joi.string().allow("", null).optional(),
  markdown_pct: Joi.number().allow(null).optional(),
  talker_text: Joi.string().allow("", null).optional(),
  expected_price: Joi.number().allow(null).optional(),
  expected_pct_off: Joi.number().allow(null).optional(),
  active_from: Joi.string().allow("", null).optional(),
  active_to: Joi.string().allow("", null).optional(),
}).min(1);

const membershipSchema = Joi.object({
  add: Joi.array().items(Joi.number().integer()).optional(),
  remove: Joi.array().items(Joi.number().integer()).optional(),
}).min(1);

const proofSchema = Joi.object({
  location_id: Joi.number().integer().required(),
  s3_url: Joi.string().uri().required(),
  note: Joi.string().allow("", null).optional(),
  tier: Joi.number().integer().valid(1, 2, 3).optional(),
});

const discoveryProofSchema = Joi.object({
  group_id: Joi.number().integer().required(),
  outlet_id: Joi.number().integer().required(),
  label: Joi.string().required(),
  s3_url: Joi.string().uri().required(),
  note: Joi.string().allow("", null).optional(),
});

class OffersV3TalkerRoutes {
  constructor(talkerUsecase) {
    this.talkerUsecase = talkerUsecase;
    this.init();
  }

  init() {
    // -----------------------------------------------------------------
    // Groups (HQ)
    // -----------------------------------------------------------------

    router.get("/groups", async (req, res) => {
      try {
        const data = await this.talkerUsecase.listGroups({
          status: req.query.status,
          search: req.query.search,
        });
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/groups/ungrouped", async (req, res) => {
      try {
        const data = await this.talkerUsecase.listUngrouped();
        res.json({ code: 200, data, meta: { count: data.length } });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/groups/:id(\\d+)", async (req, res) => {
      try {
        const data = await this.talkerUsecase.getGroup(
          parseInt(req.params.id, 10)
        );
        if (!data) {
          res.status(404).json({ code: 404, msg: "Group not found" });
          res.end();
          return;
        }
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/groups", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, groupSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.createGroup(
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/groups/:id(\\d+)", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, groupUpdateSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.updateGroup(
          parseInt(req.params.id, 10),
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.put("/groups/:id(\\d+)/items", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, membershipSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.setGroupItems(
          parseInt(req.params.id, 10),
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/groups/:id(\\d+)/publish", async (req, res) => {
      try {
        const result = await this.talkerUsecase.publishGroup(
          parseInt(req.params.id, 10),
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/groups/:id(\\d+)/end", async (req, res) => {
      try {
        const result = await this.talkerUsecase.endGroup(
          parseInt(req.params.id, 10),
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.delete("/groups/:id(\\d+)", async (req, res) => {
      try {
        const result = await this.talkerUsecase.deleteGroup(
          parseInt(req.params.id, 10)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/groups/merge", async (req, res) => {
      try {
        const schema = Joi.object({
          from_group_id: Joi.number().integer().required(),
          to_group_id: Joi.number().integer().required(),
        });
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.mergeGroups(
          isValid.value.from_group_id,
          isValid.value.to_group_id,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/groups/:id(\\d+)/split", async (req, res) => {
      try {
        const schema = Joi.object({
          item_codes: Joi.array().items(Joi.number().integer()).min(1).required(),
          label: Joi.string().allow("", null).optional(),
        });
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.splitGroup(
          parseInt(req.params.id, 10),
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/groups/auto-derive", async (req, res) => {
      try {
        const result = await this.talkerUsecase.autoDeriveGroups(
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/suggested/:id(\\d+)/resolve", async (req, res) => {
      try {
        const accept = req.body && req.body.accept === true;
        const result = await this.talkerUsecase.resolveSuggestedItem(
          parseInt(req.params.id, 10),
          accept,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // -----------------------------------------------------------------
    // Queue + capture (outlet staff)
    // -----------------------------------------------------------------

    router.get("/queue", async (req, res) => {
      try {
        const outlet_id = parseInt(req.query.outlet_id, 10);
        if (!outlet_id) {
          res.status(400).json({ code: 400, msg: "outlet_id is required" });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.getQueueForOutlet(
          outlet_id,
          req.query.round_date
        );
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/locations", async (req, res) => {
      try {
        const schema = Joi.object({
          group_id: Joi.number().integer().required(),
          outlet_id: Joi.number().integer().required(),
          label: Joi.string().required(),
        });
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.addLocation(
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/locations/:id(\\d+)/gone", async (req, res) => {
      try {
        const result = await this.talkerUsecase.setLocationActive(
          parseInt(req.params.id, 10),
          false,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/proofs", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, proofSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.submitProof(
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/proofs/discovery", async (req, res) => {
      try {
        const isValid = Joi.validate(req.body, discoveryProofSchema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.submitDiscoveryProof(
          isValid.value,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    // -----------------------------------------------------------------
    // HQ board
    // -----------------------------------------------------------------

    router.get("/board", async (req, res) => {
      try {
        const result = await this.talkerUsecase.getBoard(req.query.round_date);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.get("/proofs", async (req, res) => {
      try {
        const data = await this.talkerUsecase.listProofs({
          round_date: req.query.round_date,
          outlet_id: req.query.outlet_id
            ? parseInt(req.query.outlet_id, 10)
            : undefined,
          ai_verdict: req.query.ai_verdict,
          status: req.query.status,
          exceptions_only: req.query.exceptions_only === "true",
        });
        res.json({ code: 200, data });
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/proofs/:id(\\d+)/override", async (req, res) => {
      try {
        const result = await this.talkerUsecase.overrideProof(
          parseInt(req.params.id, 10),
          req.body?.review_note ?? null,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/proofs/:id(\\d+)/confirm-reject", async (req, res) => {
      try {
        const result = await this.talkerUsecase.confirmReject(
          parseInt(req.params.id, 10),
          req.body?.review_note ?? null,
          getActingUser(req)
        );
        sendResult(res, result);
      } catch (err) {
        respondError(res, err);
      }
      res.end();
    });

    router.post("/push-to-queue", async (req, res) => {
      try {
        const schema = Joi.object({
          group_id: Joi.number().integer().required(),
          outlet_id: Joi.number().integer().allow(null).optional(),
        });
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error) {
          res.status(400).json({ code: 400, msg: isValid.error.message });
          res.end();
          return;
        }
        const result = await this.talkerUsecase.pushToQueue(
          isValid.value.group_id,
          isValid.value.outlet_id ?? null
        );
        sendResult(res, result);
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

module.exports = (talkerUsecase) => {
  return new OffersV3TalkerRoutes(talkerUsecase);
};
