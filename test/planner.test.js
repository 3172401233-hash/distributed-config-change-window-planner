import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRollout } from '../src/planner.js';
import { executePlan } from '../src/executor.js';

const COMPATIBILITY = {
  'timeout.ms': '>=1.0.0',
  'retry.max': '>=2.0.0',
  'degradation.enabled': '>=2.3.0',
};

function baseServices() {
  return [
    {
      name: 'user-service',
      version: '2.4.0',
      features: { degradation: true },
      instances: [
        { id: 'us-1', applyAfterMs: 0 },
        { id: 'us-2', applyAfterMs: 30_000 },
      ],
    },
    {
      name: 'gateway',
      version: '2.4.0',
      features: { degradation: true },
      instances: [
        { id: 'gw-1', applyAfterMs: 5_000 },
        { id: 'gw-2', applyAfterMs: 60_000 },
      ],
      dependsOn: [{ service: 'user-service', field: 'timeout.ms' }],
    },
  ];
}

function baseScenario() {
  return {
    current: {
      'user-service': { 'timeout.ms': 2000 },
      gateway: { 'retry.max': 3, 'degradation.enabled': false },
    },
    services: baseServices(),
    changes: [
      { service: 'user-service', key: 'timeout.ms', value: 1500 },
      { service: 'gateway', key: 'degradation.enabled', value: true },
      { service: 'gateway', key: 'retry.max', value: 5 },
    ],
    compatibility: COMPATIBILITY,
    errorBudget: { maxInstancesPerBatch: 10, maxDegradationGapMs: 0 },
  };
}

test('partial application: batch is effective only after the slowest instance applies', () => {
  const plan = planRollout(baseScenario());
  const downstream = plan.batches.find((b) =>
    b.changes.some((c) => c.service === 'user-service'));
  assert.equal(downstream.pushAtMs, 0);
  assert.equal(downstream.effectiveAtMs, 30_000);

  const upstream = plan.batches.find((b) =>
    b.changes.some((c) => c.service === 'gateway' && c.key === 'degradation.enabled'));
  assert.equal(upstream.pushAtMs, 30_000);
  assert.equal(upstream.effectiveAtMs, 90_000);
});

test('cross-service dependency: upstream is never scheduled before downstream is effective', () => {
  const plan = planRollout(baseScenario());
  const downstreamIdx = plan.batches.findIndex((b) =>
    b.changes.some((c) => c.service === 'user-service'));
  const upstreamIdx = plan.batches.findIndex((b) =>
  b.changes.some((c) => c.service === 'gateway'));
  assert.ok(downstreamIdx < upstreamIdx);
  assert.ok(
    plan.batches[upstreamIdx].pushAtMs >= plan.batches[downstreamIdx].effectiveAtMs,
  );
});

test('cross-service dependency: fails when the downstream field is not planned', () => {
  const scenario = baseScenario();
  scenario.changes = scenario.changes.filter((c) => c.service !== 'user-service');
  delete scenario.current['user-service']['timeout.ms'];
  assert.throws(
    () => planRollout(scenario),
    /user-service:timeout\.ms is neither applied nor planned/,
  );
});

test('cross-service dependency: satisfied by already-applied current config', () => {
  const scenario = baseScenario();
  scenario.changes = scenario.changes.filter((c) => c.service !== 'user-service');
  scenario.current['user-service']['timeout.ms'] = 2000;
  const plan = planRollout(scenario);
  assert.ok(plan.batches.every((b) => b.changes.every((c) => c.service === 'gateway')));
});

test('retry increase is rejected while degradation is not enabled', () => {
  const scenario = baseScenario();
  scenario.changes = scenario.changes.filter((c) => c.key !== 'degradation.enabled');
  assert.throws(() => planRollout(scenario), /raises retries while degradation is not enabled/);
});

test('retry increase shares or follows the degradation window', () => {
  const plan = planRollout(baseScenario());
  const degIdx = plan.batches.findIndex((b) =>
    b.changes.some((c) => c.key === 'degradation.enabled'));
  const retryIdx = plan.batches.findIndex((b) =>
    b.changes.some((c) => c.key === 'retry.max'));
  assert.ok(retryIdx >= degIdx);
  assert.ok(
    plan.batches[retryIdx].pushAtMs >= plan.batches[degIdx].effectiveAtMs,
  );
});

test('version incompatibility is rejected', () => {
  const scenario = baseScenario();
  scenario.services[0].version = '2.1.0';
  scenario.changes = [
    { service: 'user-service', key: 'degradation.enabled', value: true },
  ];
  assert.throws(() => planRollout(scenario), /not compatible/);
});

test('degradation change is skipped when the feature flag is off', () => {
  const scenario = baseScenario();
  scenario.services[1].features.degradation = false;
  scenario.changes = [
    { service: 'user-service', key: 'timeout.ms', value: 1500 },
    { service: 'gateway', key: 'degradation.enabled', value: true },
  ];
  const plan = planRollout(scenario);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].key, 'degradation.enabled');
  assert.ok(plan.warnings.some((w) => w.includes('feature flag is off')));
});

test('error budget splits an overloaded level into sequential batches', () => {
  const scenario = baseScenario();
  scenario.errorBudget.maxInstancesPerBatch = 2;
  scenario.changes = [
    { service: 'user-service', key: 'timeout.ms', value: 1500 },
    { service: 'gateway', key: 'degradation.enabled', value: true },
  ];
  delete scenario.services[1].dependsOn;
  const plan = planRollout(scenario);
  assert.equal(plan.batches.length, 2);
  assert.ok(plan.batches[1].pushAtMs >= plan.batches[0].effectiveAtMs);
  for (const batch of plan.batches) {
    assert.ok(batch.instances.length <= 2);
  }
});

test('rollback: a failed batch restores its own keys and halts later batches', () => {
  const scenario = baseScenario();
  const plan = planRollout(scenario);
  assert.equal(plan.batches.length, 3);

  const failedId = plan.batches[1].id;
  const result = executePlan(plan, scenario.current, { failBatchId: failedId });

  assert.equal(result.status, 'rolled-back');
  assert.deepEqual(
    result.history.map((h) => h.status),
    ['applied', 'rolled-back', 'skipped'],
  );
  assert.equal(result.store['user-service']['timeout.ms'], 1500);
  assert.equal(result.store.gateway['degradation.enabled'], false);
  assert.equal(result.store.gateway['retry.max'], 3);
});

test('rollback: full run applies every batch', () => {
  const scenario = baseScenario();
  const plan = planRollout(scenario);
  const result = executePlan(plan, scenario.current);
  assert.equal(result.status, 'applied');
  assert.equal(result.store['user-service']['timeout.ms'], 1500);
  assert.equal(result.store.gateway['degradation.enabled'], true);
  assert.equal(result.store.gateway['retry.max'], 5);
});

test('rollback: a brand-new key is deleted rather than set to undefined', () => {
  const scenario = baseScenario();
  delete scenario.current.gateway['retry.max'];
  scenario.current.gateway['degradation.enabled'] = true;
  scenario.changes = [{ service: 'gateway', key: 'retry.max', value: 5 }];
  const plan = planRollout(scenario);
  assert.equal(plan.batches[0].rollback[0].action, 'delete');

  const result = executePlan(plan, scenario.current, { failBatchId: plan.batches[0].id });
  assert.equal('retry.max' in result.store.gateway, false);
});
