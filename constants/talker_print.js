/**
 * How a printed shelf talker looks. One shared setting for the whole chain -
 * these are stored as JSON, so every key needs a default here: a saved value
 * from before a control existed must still render a correct sign.
 *
 * All sizes are millimetres, because the output is a physical card and every
 * dimension has to survive whatever DPI the browser and printer choose.
 */
const DEFAULT_PRINT_SETTINGS = {
  card_w_mm: 104,
  card_h_mm: 73,
  logo_position: "top-left",
  logo_w_mm: 26,
  title_mm: 4.6,
  lead_mm: 5.2,
  big_mm: 18,
  trail_mm: 9,
  subline_mm: 4.4,
  brand_color: "#732f8d",
  offer_color: "#f15a22",
  show_border: true,
};

const LOGO_POSITIONS = ["top-left", "top-center", "top-right", "none"];

/**
 * Bounds for every numeric control. A 0mm typeface or a 300mm card prints a
 * blank or a clipped sheet, so these are enforced server-side rather than
 * trusted from the form.
 */
const PRINT_SETTING_LIMITS = {
  card_w_mm: { min: 50, max: 210 },
  card_h_mm: { min: 30, max: 297 },
  logo_w_mm: { min: 8, max: 80 },
  title_mm: { min: 2, max: 14 },
  lead_mm: { min: 2, max: 14 },
  big_mm: { min: 4, max: 45 },
  trail_mm: { min: 2, max: 25 },
  subline_mm: { min: 2, max: 14 },
};

/**
 * A4 less a safety margin. Two columns at exactly 105mm come to the full 210mm
 * page width and rounding then spills a blank page after every sheet, so the
 * grid is never allowed the last millimetres.
 */
const SHEET_W_MM = 208;
const SHEET_H_MM = 292;

/** How many cards of this size fit an A4 sheet, and the grid that holds them. */
function sheetLayout({ card_w_mm, card_h_mm }) {
  const cols = Math.max(1, Math.floor(SHEET_W_MM / card_w_mm));
  const rows = Math.max(1, Math.floor(SHEET_H_MM / card_h_mm));
  return {
    cols,
    rows,
    per_sheet: cols * rows,
    width_mm: +(cols * card_w_mm).toFixed(2),
    height_mm: +(rows * card_h_mm).toFixed(2),
  };
}

module.exports = {
  DEFAULT_PRINT_SETTINGS,
  LOGO_POSITIONS,
  PRINT_SETTING_LIMITS,
  SHEET_W_MM,
  SHEET_H_MM,
  sheetLayout,
};
