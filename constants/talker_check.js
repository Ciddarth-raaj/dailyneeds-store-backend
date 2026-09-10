require("dotenv").config();

/**
 * Model used for the talker photo check. Kept in ONE place so an accuracy shift
 * after a version change is traceable - every proof row stores the `ai_model`
 * it was judged by.
 */
const TALKER_CHECK_MODEL = "claude-haiku-4-5";

/**
 * A reject is expensive (it becomes an HQ operational finding) and a false
 * reject destroys staff trust, so a low-confidence reject is re-checked once on
 * a stronger model before it is shown. Small fraction of volume.
 */
const TALKER_CHECK_ESCALATION_MODEL = "claude-sonnet-5";

/** Below this, a field's answer is not trusted: retake rather than reject. */
const LOW_CONFIDENCE_THRESHOLD = 0.7;

module.exports = {
  TALKER_CHECK_MODEL,
  TALKER_CHECK_ESCALATION_MODEL,
  LOW_CONFIDENCE_THRESHOLD,
};
