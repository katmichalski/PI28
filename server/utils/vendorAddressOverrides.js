// Address-to-vendor overrides.
//
// Purpose: When vendor detection fails (no list/fuzzy/header hit), some invoices still
// include a stable mailing address block that uniquely identifies the vendor.
//
// This module provides a conservative fallback: only trigger an override when ALL
// required address signals are present.

/**
 * @typedef {Object} AddressOverride
 * @property {string} vendor
 * @property {RegExp[]} mustMatch  // ALL regexes must match the text
 */

/** @type {AddressOverride[]} */
const OVERRIDES = [
  // CT Filing & Search Services, LLC
  {
    vendor: "CT Filing & Search Services, LLC",
    mustMatch: [
      /\b59\s+dogwood\s+(?:rd\b|rd\.|road\b)/i,
      /\bwethersfield\b/i,
      /\b06109\b/i
    ]
  },

  // PST Abstracting, Inc.
  {
    vendor: "PST Abstracting, Inc.",
    mustMatch: [
      // OCR often confuses I/l in "Ivy" and may abbreviate "Point" as "Pt".
      /\b38\s+[il]vy\s+(?:rd\b|rd\.|road\b)/i,
      /\brocky\s+(?:point|pt)\b/i,
      // Allow "NY", "N Y", or "New York".
      /\b(?:new\s*york|n\s*y|ny)\b/i,
      // Occasionally 8 is OCR'd as B.
      /\b1177[8b]\b/i
    ]
  }
];

function normalizeLoose(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns a vendor name if the text matches a known address block; otherwise empty string.
 * This is intentionally conservative to avoid false positives.
 *
 * @param {string} text
 * @returns {string}
 */
export function vendorOverrideFromAddress(text) {
  const t = normalizeLoose(text);
  if (!t) return "";

  for (const o of OVERRIDES) {
    let ok = true;
    for (const re of o.mustMatch) {
      if (!re.test(t)) {
        ok = false;
        break;
      }
    }
    if (ok) return o.vendor;
  }

  return "";
}

// Export the overrides list so it is easy to extend in the future.
export function listVendorAddressOverrides() {
  return OVERRIDES.map((o) => ({ vendor: o.vendor, mustMatch: o.mustMatch.map((r) => String(r)) }));
}
