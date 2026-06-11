function trimStr(v) {
  if (v == null) return "";
  return String(v).trim();
}

function parseNum(v) {
  const n = Number(trimStr(v));
  return Number.isFinite(n) ? n : null;
}

function formatPrice(n) {
  if (n == null) return null;
  return (Math.round(n * 100 + Number.EPSILON) / 100).toFixed(2);
}

function normalizeMarkupDownKey(value) {
  return trimStr(value).toLowerCase().replace(/\s+/g, "");
}

function isPercentageMode(amtPerc) {
  const normalized = trimStr(amtPerc).toLowerCase();
  if (!normalized) return false;
  if (
    normalized === "amount" ||
    normalized === "amt" ||
    normalized === "value"
  ) {
    return false;
  }
  return (
    normalized.includes("perc") || normalized === "%" || normalized === "pct"
  );
}

function normalizeMrpKey(v) {
  const n = Number(trimStr(v));
  return Number.isFinite(n) ? String(n) : trimStr(v);
}

function buildIssueMrpSet(issueMrps) {
  if (!Array.isArray(issueMrps) || !issueMrps.length) {
    return new Set();
  }
  return new Set(
    issueMrps.map((mrp) => normalizeMrpKey(mrp)).filter((mrp) => mrp !== "")
  );
}

function isMarkup(markupDown) {
  const key = normalizeMarkupDownKey(markupDown);
  return key.includes("markup") && !key.includes("markdown");
}

function isMarkdown(markupDown) {
  return normalizeMarkupDownKey(markupDown).includes("markdown");
}

function parseMarkupdownRule(row) {
  if (!row) return null;
  return {
    markupDown: trimStr(row.mpfd_markup_down),
    amtPerc: trimStr(row.mpfd_amt_perc),
    value: parseNum(row.mpfd_value),
    roundoffType: trimStr(row.mpfd_roundoff_type),
    roundoffValue: parseNum(row.mpfd_roundoff_value),
  };
}

function applyRoundoff(raw, roundoffType, roundoffValue) {
  const type = trimStr(roundoffType).toLowerCase();
  if (!type || type === "none") return raw;

  const incrementPaise = Math.round(Number(roundoffValue));
  if (!Number.isFinite(incrementPaise) || incrementPaise <= 0) return raw;

  const rawPaise = Math.round(raw * 100 + Number.EPSILON);

  if (type.includes("upper")) {
    return (Math.ceil(rawPaise / incrementPaise) * incrementPaise) / 100;
  }
  if (type.includes("near")) {
    return (Math.round(rawPaise / incrementPaise) * incrementPaise) / 100;
  }
  return raw;
}

function calculateExpectedSelling({ rule, purchasePrice, mrp }) {
  const parsed =
    rule && rule.markupDown != null ? rule : parseMarkupdownRule(rule);
  if (!parsed) return null;

  const { markupDown, amtPerc, value, roundoffType, roundoffValue } = parsed;
  if (value == null) return null;

  const isPercentage = isPercentageMode(amtPerc);
  let raw = null;

  if (isMarkup(markupDown)) {
    const base = parseNum(purchasePrice);
    if (base == null) return null;
    const delta = isPercentage ? (base * value) / 100 : value;
    raw = base + delta;
  } else if (isMarkdown(markupDown)) {
    const base = parseNum(mrp);
    if (base == null) return null;
    const delta = isPercentage ? (base * value) / 100 : value;
    raw = base - delta;
  } else {
    return null;
  }

  return formatPrice(applyRoundoff(raw, roundoffType, roundoffValue));
}

function buildExpectedSellingPrices(items, rule, issueMrps = []) {
  const parsed = parseMarkupdownRule(rule);
  if (!parsed || !items?.length) return [];

  const issueMrpSet = buildIssueMrpSet(issueMrps);
  const results = [];
  const seen = new Set();

  if (isMarkup(parsed.markupDown)) {
    for (const item of items) {
      const mrp = trimStr(item.Old_MRP ?? item.old_mrp);
      if (issueMrpSet.size && !issueMrpSet.has(normalizeMrpKey(mrp))) {
        continue;
      }

      const purchasePrice = trimStr(item.Purchase_Price ?? item.purchase_price);
      const dedupeKey = issueMrpSet.size ? normalizeMrpKey(mrp) : purchasePrice;
      if (!purchasePrice || !dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const expectedSelling = calculateExpectedSelling({
        rule: parsed,
        purchasePrice,
        mrp: null,
      });
      if (expectedSelling != null) {
        results.push({
          mrp: mrp || null,
          purchasePrice,
          expectedSelling,
        });
      }
    }
    return results;
  }

  if (isMarkdown(parsed.markupDown)) {
    for (const item of items) {
      const mrp = trimStr(item.Old_MRP ?? item.old_mrp);
      if (!mrp || seen.has(mrp)) continue;
      if (issueMrpSet.size && !issueMrpSet.has(normalizeMrpKey(mrp))) {
        continue;
      }
      seen.add(mrp);

      const expectedSelling = calculateExpectedSelling({
        rule: parsed,
        purchasePrice: null,
        mrp,
      });
      if (expectedSelling != null) {
        results.push({
          mrp,
          purchasePrice: null,
          expectedSelling,
        });
      }
    }
  }

  return results;
}

function mapMarkupdownExportFields(rule) {
  if (!rule) {
    return {
      mpfd_markup_down: "",
      mpfd_price_parameter: "",
      mpfd_value: "",
      mpfd_amt_perc: "",
      mpfd_roundoff_type: "",
      mpfd_roundoff_value: "",
    };
  }

  return {
    mpfd_markup_down: trimStr(rule.mpfd_markup_down),
    mpfd_price_parameter: trimStr(rule.mpfd_price_parameter),
    mpfd_value: trimStr(rule.mpfd_value),
    mpfd_amt_perc: trimStr(rule.mpfd_amt_perc),
    mpfd_roundoff_type: trimStr(rule.mpfd_roundoff_type),
    mpfd_roundoff_value: trimStr(rule.mpfd_roundoff_value),
  };
}

function enrichLineItemExpectedSelling(lineItem, rule) {
  const exportFields = mapMarkupdownExportFields(rule);
  const parsed = parseMarkupdownRule(rule);
  if (!parsed) {
    return { ...lineItem, ...exportFields, Expected_Selling: "" };
  }

  const expectedSelling = calculateExpectedSelling({
    rule: parsed,
    purchasePrice: lineItem.Purchase_Price,
    mrp: lineItem.Old_MRP,
  });

  return {
    ...lineItem,
    ...exportFields,
    Expected_Selling: expectedSelling ?? "",
  };
}

module.exports = {
  parseMarkupdownRule,
  applyRoundoff,
  calculateExpectedSelling,
  buildExpectedSellingPrices,
  enrichLineItemExpectedSelling,
};
