export function executePlan(plan, current, { failBatchId } = {}) {
  const store = structuredClone(current);
  const history = [];
  let failed = false;

  for (const batch of plan.batches) {
    if (failed) {
      history.push({ batch: batch.id, status: 'skipped' });
      continue;
    }
    if (batch.id === failBatchId) {
      for (const entry of batch.rollback) {
        if (entry.action === 'delete') {
          delete store[entry.service]?.[entry.key];
        } else {
          store[entry.service] ??= {};
          store[entry.service][entry.key] = entry.value;
        }
      }
      history.push({ batch: batch.id, status: 'rolled-back' });
      failed = true;
      continue;
    }
    for (const change of batch.changes) {
      store[change.service] ??= {};
      store[change.service][change.key] = change.value;
    }
    history.push({ batch: batch.id, status: 'applied' });
  }

  return { store, history, status: failed ? 'rolled-back' : 'applied' };
}
