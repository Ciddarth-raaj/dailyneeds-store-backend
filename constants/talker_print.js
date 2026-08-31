/**
 * How a printed shelf talker looks. One shared setting for the whole chain -
 * these are stored as JSON, so every key needs a default here: a saved value
 * from before a control existed must still render a correct sign.
 *
 * Sizes are millimetres, because the output is a physical card and every
 * dimension has to survive whatever DPI the browser and printer choose.
 * Positions are percentages of the card, so moving an element keeps its place
 * when the card size changes.
 */

/** Every element that can be placed on the card, and where it starts. */
const ELEMENTS = ["logo", "title", "lead", "big", "subline", "price"];

const DEFAULT_PRINT_SETTINGS = {
  card_w_mm: 104,
  card_h_mm: 73,

  show_logo: true,
  logo_w_mm: 26,
  logo_x: 16,
  logo_y: 10,

  title_mm: 4.0,
  title_x: 50,
  title_y: 33,

  lead_mm: 5.2,
  lead_x: 50,
  lead_y: 50,

  big_mm: 15,
  big_x: 50,
  big_y: 64,

  trail_mm: 9,

  subline_mm: 4.4,
  subline_x: 50,
  subline_y: 80,

  show_price: true,
  price_mm: 4.0,
  price_x: 50,
  price_y: 92,

  brand_color: "#732f8d",
  offer_color: "#f15a22",
  show_border: true,
};

/**
 * Bounds for every numeric control. A 0mm typeface or a 300mm card prints a
 * blank or a clipped sheet, so these are enforced server-side rather than
 * trusted from the form. Positions are clamped to the card itself - an element
 * dragged off the edge would simply not print.
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
  price_mm: { min: 2, max: 14 },
};
for (const el of ELEMENTS) {
  PRINT_SETTING_LIMITS[`${el}_x`] = { min: 0, max: 100 };
  PRINT_SETTING_LIMITS[`${el}_y`] = { min: 0, max: 100 };
}

/**
 * Where the pre-drag `logo_position` dropdown put the logo. Kept so a setting
 * saved before the card was draggable still lands the logo where it was.
 */
const LEGACY_LOGO_POSITIONS = {
  "top-left": { logo_x: 16, logo_y: 10, show_logo: true },
  "top-center": { logo_x: 50, logo_y: 10, show_logo: true },
  "top-right": { logo_x: 84, logo_y: 10, show_logo: true },
  none: { show_logo: false },
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
  ELEMENTS,
  DEFAULT_PRINT_SETTINGS,
  LEGACY_LOGO_POSITIONS,
  PRINT_SETTING_LIMITS,
  SHEET_W_MM,
  SHEET_H_MM,
  sheetLayout,
};
