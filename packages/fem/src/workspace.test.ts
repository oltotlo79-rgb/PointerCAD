import { it } from 'vitest';
import { analysisInputChecks } from './analysisCases.testSupport.js';

it('runs the existing complete static beam input and identity contract', async () => {
  await analysisInputChecks();
});
