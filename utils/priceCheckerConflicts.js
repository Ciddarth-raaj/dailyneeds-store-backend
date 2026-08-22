const SP_TOLERANCE = 0.1;
const MARKDOWN_PP_TOLERANCE = 0.2;
const FLOAT_EPS = 1e-6;

function trimStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

function parseNum(v) {
  const s = trimStr(v);
  if (!s || s.toLowerCase() === "none" || s.toLowerCase() === "null") {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function exceeds(gap, threshold) {
  return gap > threshold + FLOAT_EPS;
}

function withinTolerance(gap, threshold) {
  return gap <= threshold + FLOAT_EPS;
}

function numericGap(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  return round2(Math.max(...values) - Math.min(...values));
}

/** Prefer New_* when filled; otherwise Old_*. */
function preferFilled(newVal, oldVal) {
  if (trimStr(newVal) !== "" && parseNum(newVal) != null) {
    return parseNum(newVal);
  }
  return parseNum(oldVal);
}

/**
 * Resolve pricing basis type from mpfd_price_parameter.
 * @returns {"MRP"|"Purchase"}
 */
function resolveBasisType(mpfdPriceParameter) {
  const p = trimStr(mpfdPriceParameter).toLowerCase();
  if (p === "landing cost" || p === "purchase price") {
    return "Purchase";
  }
  // MRP, blank, None, Markup Selling, or any unknown → MRP fallback
  return "MRP";
}

function getEffectiveMrp(item) {
  return preferFilled(item.New_MRP, item.Old_MRP);
}

function getEffectiveSp(item) {
  return preferFilled(item.New_Selling_Price, item.Old_Selling_Price);
}

function getEffectivePurchase(item) {
  return parseNum(item.Purchase_Price);
}

function getBasisValue(item, basisType) {
  const raw =
    basisType === "Purchase" ? getEffectivePurchase(item) : getEffectiveMrp(item);
  return raw == null ? null : round2(raw);
}

function basisLabel(basisType) {
  return basisType === "Purchase" ? "PP" : "MRP";
}

function groupKey(basisType, basisValue) {
  return `${basisType}|${basisValue}`;
}

function formatPriceKey(n) {
  if (n == null) return "";
  const fixed = round2(n).toFixed(2);
  if (fixed.endsWith(".00")) return fixed.slice(0, -3);
  if (fixed.endsWith("0")) return fixed.slice(0, -1);
  return fixed;
}

function computeMarkdownPct(mrp, sp) {
  if (mrp == null || sp == null || mrp === 0) return null;
  return round2(100 - (sp / mrp) * 100);
}

function computeFlatDiff(mrp, sp) {
  if (mrp == null || sp == null) return null;
  return round2(mrp - sp);
}

function buildBasisGroups(items = []) {
  const groupsMap = new Map();

  for (const item of items) {
    const basisType = resolveBasisType(item.mpfd_price_parameter);
    const basisValue = getBasisValue(item, basisType);
    const sp = getEffectiveSp(item);
    if (basisValue == null || sp == null) continue;

    const key = groupKey(basisType, basisValue);
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        basisType,
        basisValue,
        basisLabel: basisLabel(basisType),
        mrp:
          basisType === "MRP"
            ? formatPriceKey(basisValue)
            : formatPriceKey(getEffectiveMrp(item)) || "",
        sellingPriceSet: new Set(),
        purchasePrices: new Set(),
        effectiveMrps: new Set(),
        itemCount: 0,
      });
    }

    const group = groupsMap.get(key);
    group.sellingPriceSet.add(round2(sp));
    group.itemCount += 1;

    const purchase = getEffectivePurchase(item);
    if (purchase != null) group.purchasePrices.add(round2(purchase));

    const mrp = getEffectiveMrp(item);
    if (mrp != null) group.effectiveMrps.add(round2(mrp));
  }

  const groups = [...groupsMap.values()].map((group) => {
    const sellingPrices = [...group.sellingPriceSet].sort((a, b) => a - b);
    const spGap =
      sellingPrices.length >= 2
        ? round2(sellingPrices[sellingPrices.length - 1] - sellingPrices[0])
        : 0;
    const hasConflict = exceeds(spGap, SP_TOLERANCE);

    return {
      basisType: group.basisType,
      basisValue: group.basisValue,
      basisLabel: group.basisLabel,
      mrp: group.mrp,
      sellingPrices: sellingPrices.map(formatPriceKey),
      sellingPriceNums: sellingPrices,
      spGap,
      hasConflict,
      purchasePrices: [...group.purchasePrices],
      effectiveMrps: [...group.effectiveMrps],
      itemCount: group.itemCount,
    };
  });

  groups.sort((a, b) => {
    if (a.basisType !== b.basisType) {
      return a.basisType.localeCompare(b.basisType);
    }
    return a.basisValue - b.basisValue;
  });

  return groups;
}

function evaluateRule1(groups) {
  return groups.some((group) => group.hasConflict);
}

function evaluateRule2(items = []) {
  const markdownValues = [];
  const flatValues = [];

  for (const item of items) {
    if (resolveBasisType(item.mpfd_price_parameter) !== "MRP") continue;

    const mrp = getEffectiveMrp(item);
    const sp = getEffectiveSp(item);
    if (mrp == null || sp == null || mrp === 0) continue;

    const markdownPct = computeMarkdownPct(mrp, sp);
    const flatDiff = computeFlatDiff(mrp, sp);
    if (markdownPct != null) markdownValues.push(markdownPct);
    if (flatDiff != null) flatValues.push(flatDiff);
  }

  if (markdownValues.length < 2 || flatValues.length < 2) {
    return false;
  }

  const markdownGap = numericGap(markdownValues);
  const flatGap = numericGap(flatValues);

  return (
    exceeds(markdownGap, MARKDOWN_PP_TOLERANCE) && exceeds(flatGap, SP_TOLERANCE)
  );
}

function evaluateGlobalSpGap(items = []) {
  const sps = items
    .map(getEffectiveSp)
    .filter((value) => value != null)
    .map(round2);
  return { sps, gap: numericGap(sps) };
}

/**
 * Purchase/Landing basis, not a conflict, PP gap > ₹0.10 across batches.
 */
function isMarkupVerify(items = []) {
  const purchaseItems = items.filter(
    (item) => resolveBasisType(item.mpfd_price_parameter) === "Purchase"
  );
  if (purchaseItems.length < 2) return false;

  const purchases = purchaseItems
    .map(getEffectivePurchase)
    .filter((value) => value != null)
    .map(round2);

  return exceeds(numericGap(purchases), SP_TOLERANCE);
}

/**
 * Analyze line items for one product (Item_Code).
 * Items should already include mpfd_price_parameter when available.
 */
function analyzeProductItems(items = []) {
  const groups = buildBasisGroups(items);
  const rule1Conflict = evaluateRule1(groups);
  const rule2Conflict = evaluateRule2(items);
  const { sps: allSps, gap: globalSpGap } = evaluateGlobalSpGap(items);

  const stableSpOverride =
    allSps.length >= 2 && withinTolerance(globalSpGap, SP_TOLERANCE);
  const rawConflict = rule1Conflict || rule2Conflict;
  const overriddenByStableSp = rawConflict && stableSpOverride;
  const hasConflict = rawConflict && !stableSpOverride;

  const conflictReasons = [];
  if (rule1Conflict) conflictReasons.push("rule1");
  if (rule2Conflict) conflictReasons.push("rule2");

  let conflictExportClass = null;
  if (hasConflict) {
    conflictExportClass = "conflict";
  } else if (isMarkupVerify(items)) {
    conflictExportClass = "markup_verify";
  }

  return {
    groups,
    hasConflict,
    rule1Conflict,
    rule2Conflict,
    rawConflict,
    globalSpGap,
    stableSpOverride,
    overriddenByStableSp,
    conflictReasons,
    conflictExportClass,
  };
}

module.exports = {
  SP_TOLERANCE,
  MARKDOWN_PP_TOLERANCE,
  FLOAT_EPS,
  trimStr,
  parseNum,
  round2,
  exceeds,
  withinTolerance,
  numericGap,
  preferFilled,
  resolveBasisType,
  getEffectiveMrp,
  getEffectiveSp,
  getEffectivePurchase,
  getBasisValue,
  computeMarkdownPct,
  computeFlatDiff,
  analyzeProductItems,
  isMarkupVerify,
};
