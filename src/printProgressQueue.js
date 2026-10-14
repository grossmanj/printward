// Progress is informative; the final completion callback remains authoritative.
// Queue updates in order without holding up the next printer submission.
export function createPrintProgressQueue(report, warn = console.warn) {
  let pending = Promise.resolve();
  let reportingAvailable = true;
  return {
    enqueue(payload) {
      pending = pending.then(() => reportingAvailable ? report(payload) : undefined).catch((error) => {
        // Later indexes would be rejected as out of order. The final callback
        // carries the complete confirmed result set even without progress.
        reportingAvailable = false;
        warn(error.message);
      });
    },
    drain() {
      return pending;
    }
  };
}
