/**
 * Dice coefficient on character bigrams.
 * Lightweight fuzzy matching for OCR’d vendor names.
 */
export function bigrams(s) {
  const str = String(s || "");
  const out = new Map();
  for (let i = 0; i < str.length - 1; i++) {
    const bg = str.slice(i, i + 2);
    out.set(bg, (out.get(bg) || 0) + 1);
  }
  return out;
}

export function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;

  let inter = 0;
  for (const [bg, countA] of A.entries()) {
    const countB = B.get(bg) || 0;
    inter += Math.min(countA, countB);
  }
  const totalA = Array.from(A.values()).reduce((s, n) => s + n, 0);
  const totalB = Array.from(B.values()).reduce((s, n) => s + n, 0);
  const total = totalA + totalB;
  return total ? (2 * inter) / total : 0;
}
