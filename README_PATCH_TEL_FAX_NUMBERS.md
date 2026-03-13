# Patch: Ignore TEL/FAX numbers

Changes:
- Lines starting with TEL / FAX / PHONE / TELEPHONE are ignored for vendor and invoice number extraction.
- If OCR splits TEL/FAX onto its own line, the following line is also ignored when it looks like a phone/fax number.
- Any trailing "TEL ..." / "FAX ..." tail on a mixed line is removed before extraction.

Goal: phone/fax numbers are never mistaken as vendor names or invoice numbers.
