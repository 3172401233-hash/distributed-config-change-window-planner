import { satisfies } from './version.js';

const DEGRADATION_ENABLED = 'degradation.enabled';

function changeId(service, key) {
  return `${service}:${key}`;
}

function isRetryIncrease(change, currentValue) {
  if (!change.key.startsWith('retry.')) return false;
  if (typeof change.value !== 'number') return false;
  return currentValue === undefined || change.value > currentValue;
}

export function planRollout(scenario) {
  const {
    current = {},
    services = [],
    changes = [],
    compatibility = {},
    errorBudget = {},
  } = scenario;
  const maxInstancesPerBatch = errorBudget.maxInstancesPerBatch ?? Infinity;
  const maxDegradationGapMs = errorBudget.maxDegradationGapMs ?? 0;

  const serviceByName = new Map(services.map((s) => [s.name, s]));
  const warnings = [];
  const skipped = [];

  const nodes = new Map();
  for (const change of changes) {
    const service = serviceByName.get(change.service);
    if (!service) {
      throw new Error(`unknown service: ${change.service}`);
    }
    const range = compatibility[change.key];
    if (!range) {
      throw new Error(`no compatibility range declared for key: ${change.key}`);
    }
    if (!satisfies(service.version, range)) {
      throw new Error(
        `service ${change.service}@${service.version} is not compatible with `
        + `${change.key} (requires ${range})`,
      );
    }
    if (change.key.startsWith('degradation.') && service.features?.degradation !== true) {
      skipped.push(change);
      warnings.push(
        `skipped ${changeId(change.service, change.key)}: degradation feature flag is off`,
      );
      continue;
    }
    const id = changeId(change.service, change.key);
    if (nodes.has(id)) {
      throw new Error(`duplicate change: ${id}`);
    }
    nodes.set(id, { id, change, preds: new Set(), level: 0 });
  }

  const currentValue = (service, key) => current[service]?.[key];

  const requireChange = (node, depService, depKey, reason) => {
    const depId = changeId(depService, depKey);
    const depNode = nodes.get(depId);
    if (depNode) {
      if (depNode === node) {
        throw new Error(`${node.id} cannot depend on itself`);
      }
      node.preds.add(depId);
      return;
    }
    if (currentValue(depService, depKey) !== undefined) return;
    throw new Error(
      `${node.id} ${reason}, but ${depId} is neither applied nor planned`,
    );
  };

  for (const node of nodes.values()) {
    const service = serviceByName.get(node.change.service);
    for (const dep of service.dependsOn ?? []) {
      requireChange(node, dep.service, dep.field, `depends on ${dep.service}'s new field ${dep.field}`);
    }
    for (const req of node.change.requires ?? []) {
      requireChange(node, req.service ?? node.change.service, req.key, `requires ${req.key}`);
    }
    if (isRetryIncrease(node.change, currentValue(node.change.service, node.change.key))) {
      if (currentValue(node.change.service, DEGRADATION_ENABLED) !== true) {
        const degId = changeId(node.change.service, DEGRADATION_ENABLED);
        const degNode = nodes.get(degId);
        if (!degNode || degNode.change.value !== true) {
          throw new Error(
            `${node.id} raises retries while degradation is not enabled; `
            + `plan ${degId}=true in an earlier or the same window`,
          );
        }
        node.preds.add(degId);
      }
    }
  }

  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  const successors = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const node of nodes.values()) {
    for (const predId of node.preds) {
      indegree.set(node.id, indegree.get(node.id) + 1);
      successors.get(predId).push(node.id);
    }
  }
  const queue = [...nodes.values()].filter((n) => n.preds.size === 0).map((n) => n.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    const node = nodes.get(id);
    visited += 1;
    for (const succId of successors.get(id)) {
      const succ = nodes.get(succId);
      succ.level = Math.max(succ.level, node.level + 1);
      indegree.set(succId, indegree.get(succId) - 1);
      if (indegree.get(succId) === 0) queue.push(succId);
    }
  }
  if (visited !== nodes.size) {
    throw new Error('dependency cycle detected among planned changes');
  }

  const levels = new Map();
  for (const node of nodes.values()) {
    if (!levels.has(node.level)) levels.set(node.level, []);
    levels.get(node.level).push(node);
  }

  const batches = [];
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    const levelNodes = levels.get(level);
    let group = [];
    let groupInstances = 0;
    const flush = () => {
      if (group.length > 0) batches.push(group);
      group = [];
      groupInstances = 0;
    };
    for (const node of levelNodes) {
      const service = serviceByName.get(node.change.service);
      const count = service.instances.length;
      if (group.length > 0 && groupInstances + count > maxInstancesPerBatch) {
        flush();
      }
      if (count > maxInstancesPerBatch) {
        warnings.push(
          `${node.id} alone exceeds maxInstancesPerBatch (${count} > ${maxInstancesPerBatch})`,
        );
      }
      group.push(node);
      groupInstances += count;
    }
    flush();
  }

  const batchOfNode = new Map();
  const planBatches = batches.map((group, index) => {
    const id = `batch-${index + 1}`;
    for (const node of group) batchOfNode.set(node.id, id);
    return { id, nodes: group, pushAtMs: 0, effectiveAtMs: 0 };
  });

  let previousEffective = 0;
  for (const batch of planBatches) {
    let pushAt = previousEffective;
    for (const node of batch.nodes) {
      for (const predId of node.preds) {
        const predBatch = planBatches.find((b) => b.id === batchOfNode.get(predId));
        pushAt = Math.max(pushAt, predBatch.effectiveAtMs);
      }
    }
    let maxApplyAfter = 0;
    const instances = [];
    for (const node of batch.nodes) {
      const service = serviceByName.get(node.change.service);
      for (const instance of service.instances) {
        instances.push(instance.id);
        maxApplyAfter = Math.max(maxApplyAfter, instance.applyAfterMs ?? 0);
      }
    }
    batch.pushAtMs = pushAt;
    batch.effectiveAtMs = pushAt + maxApplyAfter;
    batch.instances = instances;
    previousEffective = batch.effectiveAtMs;
  }

  for (const node of nodes.values()) {
    if (!isRetryIncrease(node.change, currentValue(node.change.service, node.change.key))) {
      continue;
    }
    if (currentValue(node.change.service, DEGRADATION_ENABLED) === true) continue;
    const degBatchId = batchOfNode.get(changeId(node.change.service, DEGRADATION_ENABLED));
    const retryBatchId = batchOfNode.get(node.id);
    const degBatch = planBatches.find((b) => b.id === degBatchId);
    const retryBatch = planBatches.find((b) => b.id === retryBatchId);
    const riskyWindowMs = degBatch.effectiveAtMs - retryBatch.effectiveAtMs;
    if (riskyWindowMs > maxDegradationGapMs) {
      throw new Error(
        `risky window for ${node.change.service} is ${riskyWindowMs}ms `
        + `(retries raised before degradation effective), `
        + `exceeds error budget maxDegradationGapMs=${maxDegradationGapMs}`,
      );
    }
  }

  return {
    batches: planBatches.map((batch) => ({
      id: batch.id,
      pushAtMs: batch.pushAtMs,
      effectiveAtMs: batch.effectiveAtMs,
      instances: batch.instances,
      changes: batch.nodes.map((node) => ({
        service: node.change.service,
        key: node.change.key,
        value: node.change.value,
      })),
      rollback: batch.nodes.map((node) => {
        const previous = currentValue(node.change.service, node.change.key);
        return previous === undefined
          ? { service: node.change.service, key: node.change.key, action: 'delete' }
          : { service: node.change.service, key: node.change.key, action: 'set', value: previous };
      }),
    })),
    warnings,
    skipped,
  };
}
