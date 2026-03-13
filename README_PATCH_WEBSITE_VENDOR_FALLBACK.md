Patch: Website/domain as last-resort vendor hint

- If vendor cannot be determined from bold header, top regions, vendor list, or heuristics,
  we extract a website/domain (e.g., "www.acme.com", "https://acme.co") from header text
  and use that domain as the vendor name before falling back to UNKNOWN_VENDOR.
- Email-like strings are already excluded; this patch also ignores unitedcorporate* domains.
