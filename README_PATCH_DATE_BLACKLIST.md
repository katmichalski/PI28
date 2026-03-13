Patch: Blacklist DATE as vendor candidate

- Vendor candidate filter now rejects common date labels:
  - DATE / INVOICE DATE
  - DATE OF INVOICE / DATE ISSUED / DUE DATE variants
  - DATE followed by a date-like value (MM/DD/YYYY, YYYY-MM-DD, etc.)

This prevents header tokens like "DATE" or "INVOICE DATE" from being selected as vendor names.
