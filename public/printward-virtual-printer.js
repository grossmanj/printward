const STORAGE_KEY = 'printward-virtual-printer-v1';
const DOCUMENT_TYPES = new Set(['packingSlip', 'attachment', 'freight', 'pallet', 'pickup']);

function validItem(item) {
  return item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.deliveryDate || ''))
    && /^\d+$/.test(String(item.orderNumber || ''))
    && DOCUMENT_TYPES.has(item.type);
}

function itemKey(item) {
  return `${item.deliveryDate}|${item.orderNumber}|${item.type}`;
}

export function createVirtualPrinter(storage) {
  let jobs = [];
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
    if (Array.isArray(saved)) {
      jobs = saved.filter((job) => Array.isArray(job?.items))
        .map((job) => ({
          label: String(job.label || 'Virtuell utskrift'),
          createdAt: String(job.createdAt || ''),
          items: job.items.filter(validItem).map((item) => ({
            deliveryDate: String(item.deliveryDate),
            orderNumber: String(item.orderNumber),
            type: item.type
          }))
        })).filter((job) => job.items.length);
    }
  } catch {
    // A blocked or corrupt session store must never affect live order loading.
  }

  function persist() {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(jobs)); } catch { /* session-only fallback */ }
  }

  return {
    has(deliveryDate, orderNumber, type) {
      const key = itemKey({ deliveryDate, orderNumber, type });
      return jobs.some((job) => job.items.some((item) => itemKey(item) === key));
    },
    addJob(label, candidateItems, createdAt = new Date().toISOString()) {
      const existing = new Set(jobs.flatMap((job) => job.items.map(itemKey)));
      const unique = new Set();
      const items = (candidateItems || []).filter(validItem).map((item) => ({
        deliveryDate: String(item.deliveryDate),
        orderNumber: String(item.orderNumber),
        type: item.type
      })).filter((item) => {
        const key = itemKey(item);
        if (existing.has(key) || unique.has(key)) return false;
        unique.add(key);
        return true;
      });
      if (!items.length) return null;
      const job = { label: String(label || 'Virtuell utskrift'), createdAt, items };
      jobs.push(job);
      persist();
      return job;
    },
    jobs() { return jobs.map((job) => ({ ...job, items: job.items.map((item) => ({ ...item })) })); },
    clear() { jobs = []; persist(); }
  };
}
