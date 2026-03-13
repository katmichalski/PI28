// Blacklist: place names (states/cities) are NEVER vendors.
// This avoids misclassifying address fragments like "NEW YORK" or "CA" as vendor names.
const _PLACE_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC"
]);

const _PLACE_STATE_NAMES = new Set([
  "ALABAMA","ALASKA","ARIZONA","ARKANSAS","CALIFORNIA","COLORADO","CONNECTICUT","DELAWARE",
  "FLORIDA","GEORGIA","HAWAII","IDAHO","ILLINOIS","INDIANA","IOWA","KANSAS","KENTUCKY",
  "LOUISIANA","MAINE","MARYLAND","MASSACHUSETTS","MICHIGAN","MINNESOTA","MISSISSIPPI",
  "MISSOURI","MONTANA","NEBRASKA","NEVADA","NEW HAMPSHIRE","NEW JERSEY","NEW MEXICO",
  "NEW YORK","NORTH CAROLINA","NORTH DAKOTA","OHIO","OKLAHOMA","OREGON","PENNSYLVANIA",
  "RHODE ISLAND","SOUTH CAROLINA","SOUTH DAKOTA","TENNESSEE","TEXAS","UTAH","VERMONT",
  "VIRGINIA","WASHINGTON","WEST VIRGINIA","WISCONSIN","WYOMING","DISTRICT OF COLUMBIA"
]);

// A pragmatic list of common cities that frequently appear as standalone lines in invoice headers/addresses.
// This is intentionally "high precision" (exact-match only) so real vendors like "NEW YORK LIFE" aren't blocked.
const _PLACE_CITY_NAMES = new Set([
  "NEW YORK","LOS ANGELES","CHICAGO","HOUSTON","PHOENIX","PHILADELPHIA","SAN ANTONIO","SAN DIEGO",
  "DALLAS","SAN JOSE","AUSTIN","JACKSONVILLE","FORT WORTH","COLUMBUS","CHARLOTTE","SAN FRANCISCO",
  "INDIANAPOLIS","SEATTLE","DENVER","WASHINGTON","BOSTON","EL PASO","DETROIT","NASHVILLE",
  "PORTLAND","MEMPHIS","OKLAHOMA CITY","LAS VEGAS","LOUISVILLE","BALTIMORE","MILWAUKEE",
  "ALBUQUERQUE","TUCSON","FRESNO","MESA","SACRAMENTO","ATLANTA","KANSAS CITY","COLORADO SPRINGS",
  "OMAHA","RALEIGH","MIAMI","LONG BEACH","VIRGINIA BEACH","OAKLAND","MINNEAPOLIS","TULSA",
  "ARLINGTON","TAMPA","NEW ORLEANS","WICHITA","CLEVELAND","BAKERSFIELD","AURORA","ANAHEIM",
  "HONOLULU","SANTA ANA","RIVERSIDE","CORPUS CHRISTI","LEXINGTON","STOCKTON","HENDERSON",
  "SAINT PAUL","ST PAUL","CINCINNATI","PITTSBURGH","ANCHORAGE","GREENSBORO","PLANO","NEWARK",
  "TOLEDO","LINCOLN","ORLANDO","CHULA VISTA","JERSEY CITY","CHANDLER","FORT WAYNE","BUFFALO",
  "DURHAM","ST PETERSBURG","SAINT PETERSBURG","IRVINE","LAREDO","LUBBOCK","MADISON","GILBERT",
  "NORFOLK","RENO","WINSTON SALEM","GLENDALE","HIALEAH","GARLAND","SCOTTSDALE","IRVING",
  "CHESAPEAKE","FREMONT","BATON ROUGE","RICHMOND","BOISE","SAN BERNARDINO","SPOKANE",
  "DES MOINES","MODESTO","BIRMINGHAM","TACOMA","ROCHESTER","OXNARD","MORENO VALLEY",
  "FAYETTEVILLE","HUNTINGTON BEACH","SALT LAKE CITY","ST LOUIS","SAINT LOUIS","TALLAHASSEE"
]);

function _placeKey(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/_/g, " ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    // OCR sometimes splits 'CORPORATE' into 'CORP ORATE'. Repair before stripping legal suffixes (CORP).
    .replace(/\bCORP\s+ORATE\b/g, "CORPORATE")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikePlaceOnly(raw) {
  const key = _placeKey(raw);
  if (!key) return false;

  // Exact match (state code/name/city name)
  if (_PLACE_STATE_CODES.has(key)) return true;
  if (_PLACE_STATE_NAMES.has(key)) return true;
  if (_PLACE_CITY_NAMES.has(key)) return true;

  // City, ST  or  City ST  (no ZIP)  — common as a standalone address line.
  // Only treat as place when it is short and purely place-like.
  const m1 = /^([A-Z][A-Z0-9 .'-]{2,}),\s*([A-Z]{2})$/.exec(key);
  if (m1 && _PLACE_STATE_CODES.has(m1[2])) return true;

  const m2 = /^([A-Z][A-Z0-9 .'-]{2,})\s+([A-Z]{2})$/.exec(key);
  if (m2 && _PLACE_STATE_CODES.has(m2[2]) && key.split(" ").length <= 5) return true;

  // City, State (full name) — uncommon but appears on some invoices.
  const m3 = /^([A-Z][A-Z0-9 .'-]{2,}),\s*([A-Z][A-Z ]{2,})$/.exec(key);
  if (m3 && _PLACE_STATE_NAMES.has(m3[2].trim())) return true;

  return false;
}

export function isBlacklistedVendorCandidate(s) {
  const raw = String(s || "").trim();
  if (!raw) return false;

  // 0) Never treat contact labels like "TEL" as vendors.
  // OCR often isolates these as standalone tokens near the header.
  const key = _placeKey(raw);
  if (/^(TEL|FAX|PHONE|TELEPHONE)\b/.test(key)) return true;
  if (key === "WWW" || key === "WEBSITE" || key === "WEB") return true;
  // OCR artifact: standalone 'ORATE' is usually the tail of 'CORPORATE' (e.g., 'CORP ORATE') and is never a real vendor.
  if (key === "ORATE") return true;
// Also never treat a pure phone/fax number line as a vendor.
// This is especially common when OCR splits "TEL 555-..." into separate lines.
const digitsOnly = raw.replace(/[^0-9]+/g, "");
const lettersOnly = raw.replace(/[^A-Za-z]+/g, "");
if (!lettersOnly && digitsOnly.length >= 7 && digitsOnly.length <= 15) return true;

  // 0b) Blacklist "UCC" as a vendor name.
  // Accepts common OCR/punctuation variants: "UCC", "U.C.C.", "U C C".
  if (/^U\s*C\s*C$/.test(key)) return true;

  // 1) Never treat contact emails as vendors (incl. OCR variants like "(at)" or "(@").
  const lowered = raw.toLowerCase();
  const emailish =
    /[a-z0-9._%+-]+\s*(?:@|\(\s*@|\(at\)|\[at\]|\s+at\s+)\s*[a-z0-9.-]+\.[a-z]{2,}/i.test(raw);
  if (emailish) return true;

  // 2) Never treat this individual contact name as a vendor.
  // Matches: "Roger Putnam", "Putnam, Roger", extra punctuation/spacing/casing.
  const compactName = lowered.replace(/[^a-z]+/g, " ").replace(/\s+/g, " ").trim();
  if (/\broger\b\s+\bputnam\b/.test(compactName) || /\bputnam\b\s+\broger\b/.test(compactName)) return true;

  // 3) (Reserved)

  // 4) Blacklist standalone place names (cities/states) so address fragments never become vendors.
  if (looksLikePlaceOnly(raw)) return true;

  return false;
}

export function normalizeVendorName(name) {
  if (!name) return "";
  return String(name)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    // OCR sometimes splits 'CORPORATE' into 'CORP ORATE'. Repair before stripping legal suffixes (CORP).
    .replace(/\bCORP\s+ORATE\b/g, "CORPORATE")
    .replace(/\b(THE|INCORPORATED|INC|LLC|L\.L\.C|LTD|LIMITED|CORP|CORPORATION|CO|COMPANY)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "_")
    .replace(/_+/g, "_");
}


// Backwards-compat helper (now a no-op).
// Previously used to strip certain phrases from stems; kept for API stability.
// Keep vendor names intact ("United Corporate Services" is a valid vendor).
// This function is retained for backwards compatibility but is now a no-op.
export function stripUnitedCorporatePhrase(s) {
  return String(s || "");
}

// Remove address-like tokens from a normalized vendor name when building output stems.
// Keeps short leading digits (e.g., 7_ELEVEN) but strips street numbers/zip codes/etc.
const _STREET_TOKENS = new Set([
  "STREET","ST","ROAD","RD","AVENUE","AVE","BOULEVARD","BLVD","DRIVE","DR","LANE","LN",
  "COURT","CT","CIRCLE","CIR","HIGHWAY","HWY","PARKWAY","PKWY","PLACE","PL","WAY",
  "TERRACE","TER","TRAIL","TRL","PIKE","PLAZA","PLZ","SQUARE","SQ","LOOP"
]);

const _UNIT_TOKENS = new Set(["SUITE","STE","APT","UNIT","FLOOR","FL","BLDG","BUILDING","RM","ROOM"]);

const _ADDR_STOP_TOKENS = new Set([
  // Contact / metadata
  "FAX","PHONE","TEL","TELEPHONE","PH","PHN","EMAIL","WEB","WWW",
  "MOBILE","CELL","CEL","CALL","EXT","EXTN","EXTENSION",
  // Common doc labels
  "REMIT","REMITTANCE","BILL","BILLTO","SHIP","SHIPTO",
  "ATTN","ATTENTION","DEPARTMENT","DEPT",
  // Address-ish
  "PO","P_O","BOX","ZIP","USA"
]);

const _US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV",
  "WI","WY","DC"
]);

export function cleanVendorForStem(vendorNorm) {
  const raw = String(vendorNorm || "").toUpperCase();
  if (!raw) return "";

  const tokens = raw.split("_").filter(Boolean);
  const out = [];
  let sawAddress = false;

  // Phone numbers often leave behind a stray leading country code "1" or single-letter labels like "T"/"P".
  // Detect common phone-ish patterns before generic numeric stripping runs.
  const isNum = (s) => /^\d+$/.test(String(s || ""));
  const numLen = (s) => String(s || "").length;
  const looksLikePhoneRun = (i) => {
    // 1 + 3 + 3 + 4 (e.g., 1_212_555_1212)
    if (
      tokens[i] === "1" &&
      isNum(tokens[i + 1]) &&
      isNum(tokens[i + 2]) &&
      isNum(tokens[i + 3]) &&
      numLen(tokens[i + 1]) === 3 &&
      numLen(tokens[i + 2]) === 3 &&
      numLen(tokens[i + 3]) === 4
    ) {
      return true;
    }

    // 1 + 10 (e.g., 1_2125551212)
    if (tokens[i] === "1" && isNum(tokens[i + 1]) && numLen(tokens[i + 1]) === 10) return true;

    // Label + digits (e.g., T_212_..., P_800_...)
    if ((tokens[i] === "T" || tokens[i] === "P") && isNum(tokens[i + 1]) && numLen(tokens[i + 1]) >= 3) return true;

    // Stray country code before any 3+ digit chunk (phone-like): 1_800_FLOWERS -> remove the 1
    if (tokens[i] === "1") {
      for (let k = 1; k <= 3; k++) {
        const tk = tokens[i + k];
        if (isNum(tk) && numLen(tk) >= 3) return true;
      }
    }

    return false;
  };

  const DIR = new Set(["N","S","E","W","NE","NW","SE","SW","NORTH","SOUTH","EAST","WEST"]);

  // Look ahead a few tokens for a street suffix; helps catch cases like "... 12 MAIN ST ..."
  const hasStreetSuffixAhead = (fromIdx) => {
    for (let j = fromIdx; j < Math.min(tokens.length, fromIdx + 7); j++) {
      if (_STREET_TOKENS.has(tokens[j])) return true;
    }
    return false;
  };

  // When we detect state+zip (or a zip), drop likely city tokens at the end (keeps first 1-2 vendor tokens)
  const popTrailingCityish = () => {
    let popped = 0;
    while (popped < 2 && out.length > 2) {
      const last = out[out.length - 1];
      if (/^[A-Z]{2,}$/.test(last)) {
        out.pop();
        popped += 1;
      } else break;
    }
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1] || "";
    const prev = tokens[i - 1] || "";

    // Remove "UNITED STATES" when it appears as an address/country line
    if (t === "UNITED" && next === "STATES") {
      sawAddress = true;
      break;
    }

    // Drop phone-ish labels/prefixes when they appear in phone patterns.
    if (looksLikePhoneRun(i)) {
      if (t === "1" && /^\d{3}$/.test(next) && /^\d{3}$/.test(tokens[i + 2] || "") && /^\d{4}$/.test(tokens[i + 3] || "")) {
        i += 3;
      } else if (t === "1" && /^\d{10}$/.test(next)) {
        i += 1;
      }
      continue;
    }

    // Stop at explicit address/metadata tokens (PO BOX / ZIP / USA, etc.)
    if (_ADDR_STOP_TOKENS.has(t)) {
      sawAddress = true;
      if ((t === "PO" || t === "P_O") && next === "BOX") {
        // consume the "BOX" token too
        i++;
      }
      break;
    }

    // Stop at state + zip (common address tail)
    if (_US_STATE_CODES.has(t) && /^\d{5}(?:\d{4})?$/.test(next)) {
      sawAddress = true;
      popTrailingCityish();
      break;
    }

    // Stop at bare zip code (e.g., "... NEW_YORK 10001")
    if (/^\d{5}(?:\d{4})?$/.test(t)) {
      sawAddress = true;
      popTrailingCityish();
      break;
    }

    // Stop at street suffix; remove likely street-name token right before it
    if (_STREET_TOKENS.has(t)) {
      sawAddress = true;
      if (out.length > 1) {
        const last = out[out.length - 1];
        // Drop the street name token (MAIN, BROADWAY, etc.)
        if (/^[A-Z]{2,}$/.test(last)) out.pop();
      }
      break;
    }

    // Stop at unit tokens when followed by a number (SUITE 200, APT 3, etc.)
    if (_UNIT_TOKENS.has(t) && /^\d{1,5}$/.test(next)) {
      sawAddress = true;
      break;
    }

    // Drop directional tokens when they look addressy (often appear around streets)
    if (DIR.has(t) && (hasStreetSuffixAhead(i + 1) || _STREET_TOKENS.has(next))) {
      sawAddress = true;
      break;
    }

    // Drop numeric chunks:
    // - keep a short leading digit token for brands like 7_ELEVEN or 84_LUMBER
    // - otherwise, digits usually indicate addresses/suites/zip/etc. and should not be in filenames
    if (isNum(t)) {
      if (i === 0 && numLen(t) <= 2) {
        out.push(t);
        continue;
      }
      // If we see a number after the vendor name and a street suffix is nearby, treat it as address start.
      if (out.length && (numLen(t) >= 3 || hasStreetSuffixAhead(i + 1))) {
        sawAddress = true;
        break;
      }
      // Otherwise just drop short numeric tokens (e.g., STE_12) without stopping.
      continue;
    }

    // Drop unit numbers after SUITE/STE/APT/etc.
    if (/^\d{1,4}$/.test(t) && _UNIT_TOKENS.has(prev)) continue;

    // Drop long numeric-like junk (already handled by isNum, but keep for safety)
    if (/^\d{3,}$/.test(t)) continue;

    out.push(t);
    if (out.length >= 8) break;
  }

  // Trim trailing numeric junk if any
  while (out.length && /^\d{1,4}$/.test(out[out.length - 1]) && out.length > 1) out.pop();

  const cleaned = out.join("_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  // If we detected address-ish content, NEVER fall back to raw (raw often includes city/state/address)
  if (sawAddress) return cleaned;

  // Otherwise, only use cleaned if it still looks meaningful
  return cleaned && cleaned.length >= 3 ? cleaned : raw;
}


export function sanitizeFilenameStem(stem) {
  // Keep spaces (user preference) but remove filesystem-unsafe characters.
  // Also tighten the single underscore separator between vendor and invoice.
  return stripUnitedCorporatePhrase(String(stem || ""))
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/\s*_\s*/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    // Windows dislikes trailing dots/spaces
    .replace(/[. ]+$/g, "")
    .slice(0, 140);
}

// Convert a vendor-like string (often ALL_CAPS with underscores) into a readable
// vendor name that keeps SPACES (no underscores between words).
// - If the string already has lowercase letters, we assume it's user-curated and keep its casing.
// - Otherwise, we Title-Case words while preserving acronyms (e.g., UPS) and short digit+letter brands (e.g., 3M).
export function toVendorDisplayName(vendorLike) {
  const s0 = stripUnitedCorporatePhrase(String(vendorLike || "")).trim();
  if (!s0) return "";

  const s = s0
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/[_\-]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";

  // Mixed-case input: keep it (just normalized spacing)
  if (/[a-z]/.test(s)) return s;

  const tokens = s.split(" ").filter(Boolean);
  const out = tokens.map((tok) => {
    if (/^\d+$/.test(tok)) return tok;
    if (/^[A-Z]{1,3}$/.test(tok)) return tok; // acronyms
    if (/^[0-9A-Z]{1,5}$/.test(tok) && /[0-9]/.test(tok) && /[A-Z]/.test(tok)) return tok; // 3M, 7UP

    const lower = tok.toLowerCase();
    const m = lower.match(/[a-z]/);
    if (!m) return tok;
    const i = m.index ?? 0;
    return lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
  });

  return out.join(" ").replace(/\s+/g, " ").trim();
}

// Convert an arbitrary stem (often containing underscores/spaces/hyphens) into lowerCamelCase.
// Examples:
//   "ACME_SUPPLY_123" -> "acmeSupply123"
//   "7_ELEVEN"       -> "7Eleven"
//   "Foo Bar"        -> "fooBar"
export function toLowerCamelCaseStem(stem) {
  const s0 = String(stem || "");
  const s = stripUnitedCorporatePhrase(s0).trim();
  if (!s) return "";

  // Normalize separators to spaces, then extract alphanumeric tokens.
  const tokens = s
    .replace(/[\/_\-]+/g, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/g)
    .filter(Boolean);

  if (!tokens.length) return "";

  // If the user already typed a single-token camelCase/PascalCase stem, keep internal caps.
  if (tokens.length === 1) {
    const tok = tokens[0];
    if (/[a-z]/.test(tok) && /[A-Z]/.test(tok)) {
      return tok.charAt(0).toLowerCase() + tok.slice(1);
    }
  }


  const capAfterDigits = (tokLower) => {
    const m = tokLower.match(/[a-z]/);
    if (!m) return tokLower; // digits only
    const idx = m.index ?? 0;
    return tokLower.slice(0, idx) + tokLower[idx].toUpperCase() + tokLower.slice(idx + 1);
  };

  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const rawTok = tokens[i];
    if (!rawTok) continue;
    const lower = rawTok.toLowerCase();
    if (i === 0) out.push(lower);
    else out.push(capAfterDigits(lower));
  }

  return out.join("");
}


// Normalize an output stem so it follows <Vendor Name>_<InvoiceNumber>.
// - Vendor keeps SPACES (no underscores between words)
// - Separator between vendor and invoice is a SINGLE underscore
// - Invoice keeps digits with an optional single hyphen
export function normalizeVendorInvoiceStem(stem) {
  const s0 = stripUnitedCorporatePhrase(String(stem || ""))
    .replace(/\.pdf$/i, "")
    .trim();

  const cleaned = s0
    .replace(/[\/\\?%*:|"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let vendorPart = cleaned;
  let invPart = "";

  // Prefer a trailing invoice-like token (digits with optional single hyphen).
  const m = cleaned.match(/([0-9][0-9\-]{1,24})\s*$/);
  if (m) {
    const inv = normalizeInvoiceNumber(m[1]);
    if (inv) {
      invPart = inv;
      vendorPart = cleaned.slice(0, m.index).trim();
    }
  }

  // If not found, also support "Vendor_Invoice" forms.
  if (!invPart && cleaned.includes("_")) {
    const parts = cleaned.split(/_+/g).filter(Boolean);
    if (parts.length >= 2) {
      const inv = normalizeInvoiceNumber(parts[parts.length - 1]);
      if (inv) {
        invPart = inv;
        vendorPart = parts.slice(0, -1).join(" ").trim();
      }
    }
  }

  const vendorName = toVendorDisplayName(vendorPart) || "Output";
  const invFinal = invPart || "unknownInvoice";
  return `${vendorName}_${invFinal}`;
}

export function digitsOnly(s) {
  const d = String(s || "").replace(/\D+/g, "");
  return d;
}

export function normalizeInvoiceNumber(raw) {
  // Invoice number rules (updated):
  // - digits only, with optional single hyphen '-'
  // - MAY include a single letter (A-Z) in total (common formats: 1V, 123A, A123, 12-345A)
  // - if hyphen exists, it appears AFTER at least 2 digits (e.g., 12-3456)
  //   and must have at least 1 digit on the RIGHT side
  // - at most 16 digits total (hyphen not counted)
  // - if there is NO letter, typically at least 2 digits
  const s = String(raw || "").trim();
  if (!s) return "";

  // Keep digits, letters, and hyphen only
  let cleaned = s.toUpperCase().replace(/[^A-Z0-9\-]+/g, "");

  // Collapse multiple hyphens to one by keeping the first
  const firstHyphen = cleaned.indexOf("-");
  if (firstHyphen !== -1) {
    cleaned = cleaned.slice(0, firstHyphen + 1) + cleaned.slice(firstHyphen + 1).replace(/-/g, "");
  }

  // Remove leading/trailing hyphen
  cleaned = cleaned.replace(/^-+/, "").replace(/-+$/, "");

  // Enforce: at most ONE letter total
  const letters = cleaned.replace(/[^A-Z]+/g, "");
  if (letters.length > 1) return "";

  // If there is a single letter, it must be at the START or END (not in the middle)
  if (letters.length === 1) {
    const L = letters;
    const starts = cleaned.startsWith(L);
    const ends = cleaned.endsWith(L);
    // Special-case: a single-letter invoice number
    if (cleaned === L) return L;
    if (!(starts || ends)) return "";
  }

  // Hyphen position rule:
  // - left side >= 2 digits (ignoring any leading letter)
  // - right side >= 1 digit
  if (cleaned.includes("-")) {
    const [a, b] = cleaned.split("-", 2);
    const aDigits = String(a || "").replace(/\D+/g, "");
    const bDigits = String(b || "").replace(/\D+/g, "");
    if (!aDigits || aDigits.length < 2 || !bDigits || bDigits.length < 1) {
      // If it doesn't meet the rule, drop the hyphen and keep digits only
      cleaned = (a || "") + (b || "");
      cleaned = cleaned.replace(/-/g, "");
    }
  }

  // Enforce digit count <= 16 (excluding hyphen)
  const digits = cleaned.replace(/\D+/g, "");
  const letterCount = (cleaned.replace(/[^A-Z]+/g, "") || "").length;

  // If there are no digits, only allow a single-letter invoice number.
  if (digits.length === 0) {
    const lone = cleaned.replace(/-/g, "");
    return /^[A-Z]$/.test(lone) ? lone : "";
  }

  // Minimum digits: if no letter, require >=2 digits; if letter present, allow >=1 digit.
  if (letterCount === 0 && digits.length < 2) return "";
  if (letterCount === 1 && digits.length < 1) return "";

  if (digits.length > 16) {
    // If we exceed digit cap, truncate digits and drop hyphen (rare), preserving a leading/trailing letter.
    const L = letters.length === 1 ? letters : "";
    const keepLeading = L && cleaned.startsWith(L);
    const keepTrailing = L && cleaned.endsWith(L);
    const d = digits.slice(0, 16);
    return `${keepLeading ? L : ""}${d}${keepTrailing ? L : ""}`;
  }

  // If we had hyphen and total digits ok, keep cleaned; otherwise ensure we didn't grow too long.
  // Max length = 16 digits + 1 hyphen + 1 letter = 18.
  if (cleaned.length > 18) {
    const L = letters.length === 1 ? letters : "";
    const keepLeading = L && cleaned.startsWith(L);
    const keepTrailing = L && cleaned.endsWith(L);
    return `${keepLeading ? L : ""}${digits}${keepTrailing ? L : ""}`;
  }

  return cleaned;
}
