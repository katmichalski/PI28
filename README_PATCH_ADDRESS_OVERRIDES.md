# Patch: Address-based Vendor Overrides

This project now supports a **conservative address fallback** for vendor detection.

## What it does

If the vendor cannot be determined from:
- vendor list matches,
- fuzzy vendor list matches,
- header heuristics,

…then the detector checks the document text for a known address block and **overrides** the vendor name.

## Where to edit

Add/update entries in:

- `server/utils/vendorAddressOverrides.js`

Each override is a vendor name plus a set of regexes that must *all* match.

## Included overrides

- `CT Filing & Search Services, LLC` for `59 Dogwood Rd … Wethersfield, CT 06109`
- `PST Abstracting, Inc.` for `38 Ivy Road … Rocky Point, NY 11778`
