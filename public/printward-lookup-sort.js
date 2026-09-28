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

export function matchesDispatchSearch(item, query) {
  const term = String(query || '').trim().toLocaleLowerCase('sv-SE');
  if (!term) return true;
  const context = item.order?.context || {};
  return [item.order?.orderNumber, context.customerNo, context.customerName,
    context.deliveryName, context.deliveryMethod, context.deliveryMethodName,
    context.dispatchTime].some((value) => String(value ?? '').toLocaleLowerCase('sv-SE').includes(term));
}

export function groupDispatchItems(items) {
  const groups = new Map();
  for (const item of items) {
    const context = item.order?.context || {};
    const code = String(context.deliveryMethod ?? '').trim();
    const name = String(context.deliveryMethodName ?? '').trim();
    const key = code ? `code:${code}` : name ? `name:${name.toLocaleLowerCase('sv-SE')}` : 'unknown';
    if (!groups.has(key)) groups.set(key, {
      key,
      label: code ? `Körsätt ${code}${name ? ` · ${name}` : ''}` : name ? `Körsätt ${name}` : 'Körsätt ej angivet',
      items: [],
      ready: 0
    });
    const group = groups.get(key);
    group.items.push(item);
    if (item.ready) group.ready += 1;
  }
  return [...groups.values()];
}
