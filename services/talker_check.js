const Anthropic = require("@anthropic-ai/sdk");
const logger = require("../utils/logger");
const {
  TALKER_CHECK_MODEL,
  TALKER_CHECK_ESCALATION_MODEL,
  LOW_CONFIDENCE_THRESHOLD,
} = require("../constants/talker_check");

/**
 * Shelf-talker photo check.
 *
 * Runs on upload so a retake happens while staff are still standing in the
 * aisle. The model only ever reports observations; the accept/retake/reject
 * verdict is derived in code below from those booleans, so the rules stay
 * auditable and tunable without reprompting.
 */

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    talker_present: { type: "boolean" },
    talker_readable: { type: "boolean" },
    brand_match: { type: "boolean" },
    price_match: { type: "boolean" },
    product_visible: { type: "boolean" },
    verdict_hint: { type: "string", enum: ["accept", "retake", "reject"] },
    reason: { type: "string" },
    confidence: { type: "number" },
  },
  required: [
    "talker_present",
    "talker_readable",
    "brand_match",
    "price_match",
    "product_visible",
    "verdict_hint",
    "reason",
    "confidence",
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  "You check photographs of retail shelf talkers (promotional signs on supermarket racks).",
  "Report only what you can actually see in the photo. Do not guess.",
  "",
  "Field meanings:",
  "- talker_present: a promotional shelf sign is visibly present in the photo.",
  "- talker_readable: its text is legible enough to read the brand and the offer.",
  "- brand_match: the sign advertises the expected brand/product block.",
  "- price_match: the price or percentage on the sign matches what is expected.",
  "- product_visible: the advertised product is visible in the same frame as the sign.",
  "  If the framing does not let you confirm this, set it false and say so in reason.",
  "- confidence: your confidence in this overall assessment, 0 to 1.",
  "",
  "If a field cannot be determined from the photo, answer false and lower confidence.",
].join("\n");

function buildExpectationText({
  group_label,
  talker_text,
  expected_price,
  expected_pct_off,
  item_names,
}) {
  const lines = [`Expected brand / offer block: ${group_label || "(unnamed)"}`];
  if (talker_text) {
    lines.push(`Expected text on the sign: ${talker_text}`);
  }
  if (expected_price !== null && expected_price !== undefined) {
    lines.push(`Expected price on the sign: ${expected_price}`);
  }
  if (expected_pct_off !== null && expected_pct_off !== undefined) {
    lines.push(`Expected discount on the sign: ${expected_pct_off}% off`);
  }
  if (item_names && item_names.length) {
    const sample = item_names.slice(0, 15).join(", ");
    const more =
      item_names.length > 15 ? ` (and ${item_names.length - 15} more)` : "";
    lines.push(`Articles covered by this sign: ${sample}${more}`);
  }
  lines.push("");
  lines.push("Assess the photo against these expectations.");
  return lines.join("\n");
}

/**
 * The verdict rules. Derived from the model's booleans, never from its own
 * verdict_hint.
 *
 * - accept  - all checks pass. Terminal, nobody acts.
 * - retake  - staff problem, fixable on the spot (unreadable, or not confident).
 * - reject  - management problem: the sign is missing, wrong brand, wrong price.
 *
 * Placement (product_visible) is deliberately NOT a hard fail: confirming the
 * sign sits above the right product depends on framing, so "can't confirm
 * placement" is reported as its own outcome instead of failing the photo.
 */
function deriveVerdict(observation) {
  const confidence = Number(observation?.confidence);
  const lowConfidence =
    !Number.isFinite(confidence) || confidence < LOW_CONFIDENCE_THRESHOLD;

  if (!observation?.talker_present) {
    return {
      verdict: "reject",
      reason: "No talker visible on the rack",
      lowConfidence,
    };
  }
  if (!observation.talker_readable) {
    return {
      verdict: "retake",
      reason: "Talker text not readable - photograph it closer / straighter",
      lowConfidence,
    };
  }
  if (!observation.brand_match) {
    return {
      verdict: "reject",
      reason: "Talker does not match the expected brand",
      lowConfidence,
    };
  }
  if (!observation.price_match) {
    return {
      verdict: "reject",
      reason: "Price on the talker does not match the offer",
      lowConfidence,
    };
  }
  if (lowConfidence) {
    return {
      verdict: "retake",
      reason: "Could not assess the photo confidently - retake it",
      lowConfidence,
    };
  }
  return {
    verdict: "accept",
    reason: observation.product_visible
      ? ""
      : "Accepted, but placement above the product could not be confirmed from this framing",
    lowConfidence,
  };
}

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function runCheck(client, model, imageUrl, expectationText) {
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: RESPONSE_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: imageUrl } },
          { type: "text", text: expectationText },
        ],
      },
    ],
  });

  const textBlock = (response.content || []).find(
    (block) => block.type === "text"
  );
  if (!textBlock) {
    throw new Error("No text block in model response");
  }
  return JSON.parse(textBlock.text);
}

/**
 * Check one talker photo.
 *
 * Returns { verdict, reason, observation, model } - never throws for a model
 * failure: a check that could not run comes back as a `retake` so staff can
 * simply shoot it again rather than the upload being lost.
 */
async function checkTalkerPhoto({
  imageUrl,
  group_label,
  talker_text,
  expected_price,
  expected_pct_off,
  item_names,
}) {
  const expectationText = buildExpectationText({
    group_label,
    talker_text,
    expected_price,
    expected_pct_off,
    item_names,
  });

  try {
    const client = getClient();

    let model = TALKER_CHECK_MODEL;
    let observation = await runCheck(
      client,
      model,
      imageUrl,
      expectationText
    );
    let derived = deriveVerdict(observation);

    // A low-confidence reject is re-checked once on a stronger model before it
    // is shown - a false reject costs far more than the extra call.
    if (derived.verdict === "reject" && derived.lowConfidence) {
      model = TALKER_CHECK_ESCALATION_MODEL;
      observation = await runCheck(client, model, imageUrl, expectationText);
      derived = deriveVerdict(observation);
    }

    return {
      verdict: derived.verdict,
      reason: derived.reason || observation.reason || "",
      observation,
      model,
    };
  } catch (err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "SERVICE.TALKER_CHECK",
      code: "SERVICE.TALKER_CHECK.FAILED",
      description: err.toString(),
      category: "",
      ref: { imageUrl },
    });
    return {
      verdict: "retake",
      reason: "Automatic check could not run - please shoot it again",
      observation: { error: err.message || String(err) },
      model: null,
    };
  }
}

module.exports = {
  checkTalkerPhoto,
  deriveVerdict,
  buildExpectationText,
  RESPONSE_SCHEMA,
};
