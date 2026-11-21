#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { planRollout } from '../src/planner.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: node bin/plan.js <scenario.json>');
  process.exit(1);
}

const scenario = JSON.parse(await readFile(path, 'utf8'));
try {
  const plan = planRollout(scenario);
  console.log(JSON.stringify(plan, null, 2));
} catch (error) {
  console.error(`planning failed: ${error.message}`);
  process.exit(1);
}
