Patch: Prefer vendor text ABOVE the line-items table ("chart")

- PDF text-layer extraction now computes an "above table header" region by detecting the first
  likely column-header row (DESCRIPTION/DESC or 2+ column tokens such as QTY/PRICE/AMOUNT/ITEM).
- Vendor + invoice number detection prefer this above-table region first.
- For PDFs with text layers (including OCRmyPDF output), this greatly improves vendor detection
  when the vendor name sits just above the table but below the top third of the page.
