/** Pure: does a new cart only repeat designs already in an earlier order? (every variant of the new cart is in the old one) */
export function sameItems(next, prev) {
  const ids = (x) => (x || []).map((l) => String(l.id || l.variant_id || '')).filter(Boolean);
  const a = ids(next), b = new Set(ids(prev));
  return a.length > 0 && b.size > 0 && a.every((id) => b.has(id));
}
