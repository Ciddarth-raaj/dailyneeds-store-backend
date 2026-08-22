const SP_TOLERANCE = 0.1;

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

/**
 * Analyze line items for one product (Item_Code).
 * Items should already include mpfd_price_parameter when available.
 *
 * @param {Array<object>} items
 * @returns {{
 *   groups: Array<object>,
 *   hasConflict: boolean,
 *   conflictExportClass: "conflict"|"markup_verify"|null
 * }}
 */
function analyzeProductItems(items = []) {
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
    const hasConflict = spGap > SP_TOLERANCE;

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

  const hasConflict = groups.some((g) => g.hasConflict);

  let conflictExportClass = null;
  if (hasConflict) {
    conflictExportClass = "conflict";
  } else if (isMarkupVerify(items, groups)) {
    conflictExportClass = "markup_verify";
  }

  return {
    groups,
    hasConflict,
    conflictExportClass,
  };
}

/**
 * Purchase/Landing basis, not a conflict, and interesting for spot-check:
 * PP gap > 0.10 OR 0 < SP gap <= 0.10 OR >= 2 distinct effective MRPs.
 */
function isMarkupVerify(items, groups) {
  const purchaseItems = (items || []).filter(
    (item) => resolveBasisType(item.mpfd_price_parameter) === "Purchase"
  );
  if (purchaseItems.length < 2) return false;

  const purchases = purchaseItems
    .map(getEffectivePurchase)
    .filter((v) => v != null)
    .map(round2);
  const sps = purchaseItems
    .map(getEffectiveSp)
    .filter((v) => v != null)
    .map(round2);
  const mrps = [
    ...new Set(
      purchaseItems
        .map(getEffectiveMrp)
        .filter((v) => v != null)
        .map(round2)
    ),
  ];

  const ppGap =
    purchases.length >= 2 ? round2(Math.max(...purchases) - Math.min(...purchases)) : 0;
  const spGap = sps.length >= 2 ? round2(Math.max(...sps) - Math.min(...sps)) : 0;

  if (ppGap > SP_TOLERANCE) return true;
  if (spGap > 0 && spGap <= SP_TOLERANCE) return true;
  if (mrps.length >= 2) return true;

  // Also accept near-ties within a same-basis group from analyze output
  if (
    (groups || []).some(
      (g) =>
        g.basisType === "Purchase" &&
        g.spGap > 0 &&
        g.spGap <= SP_TOLERANCE
    )
  ) {
    return true;
  }

  return false;
}

module.exports = {
  SP_TOLERANCE,
  trimStr,
  parseNum,
  round2,
  preferFilled,
  resolveBasisType,
  getEffectiveMrp,
  getEffectiveSp,
  getEffectivePurchase,
  getBasisValue,
  analyzeProductItems,
  isMarkupVerify,
};
