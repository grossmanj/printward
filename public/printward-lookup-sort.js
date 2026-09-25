const collator = new Intl.Collator('sv-SE', { numeric: true, sensitivity: 'base' });

function methodNumber(item) {
  const value = Number(item.order?.context?.deliveryMethod);
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function priorityNumber(item) {
  const value = Number(item.order?.context?.dispatchPriority);
  return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

export function sortLookupItems(items, sortBy) {
  if (sortBy !== 'method') return items;
  return [...items].sort((a, b) => methodNumber(a) - methodNumber(b)
    || collator.compare(String(a.order?.context?.deliveryMethodName || ''), String(b.order?.context?.deliveryMethodName || ''))
    || priorityNumber(a) - priorityNumber(b)
    || collator.compare(String(a.order?.orderNumber || ''), String(b.order?.orderNumber || '')));
}
