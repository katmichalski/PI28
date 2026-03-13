Contact blacklists (non-vendor lines)

This build treats the following as NON-VENDOR content anywhere vendor candidates are evaluated:

- Any email address / email-like token (including OCR variants like "(at)" or "(@")
- The contact name "Roger Putnam" (also matches "Putnam, Roger")

Why:
These commonly appear in invoice headers and were being picked up as vendor names.
