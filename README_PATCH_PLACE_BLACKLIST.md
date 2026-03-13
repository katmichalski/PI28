Patch: Place blacklist (states & cities are not vendors)

What changed
- Vendor candidate filtering now rejects standalone place names (US state codes/names + common city names).
- This prevents address fragments like "NY", "California", "New York", "Miami" from being selected as vendor names
  when OCR is noisy or the header is sparse.

Where
- server/utils/normalize.js
  - Added looksLikePlaceOnly() and place name sets
  - isBlacklistedVendorCandidate() now returns true for place-only candidates

Notes
- Matching is exact (after normalization) to avoid blocking real vendors that *contain* city/state words,
  e.g. "NEW YORK LIFE" is not blocked.
