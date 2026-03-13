Ampersand (&) vendor rule

Change:
- If a header/vendor candidate line contains an ampersand (e.g., "A & B"), the app will NOT accept a vendor-list match that only covers one side ("A" or "B").
- When an ampersand partnership name is present near the top, heuristic fallback prefers that full line.

Files:
- server/utils/detect.js
