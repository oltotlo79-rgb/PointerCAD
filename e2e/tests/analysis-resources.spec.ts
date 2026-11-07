import { test } from '@playwright/test';
import { ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS } from './assembly1000HostFlow.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';
import { analysisResourcesFlow } from './analysisResourcesFlow.js';

test('1000 CAD components and separately bounded real single-solid FEM', async ({ page }, info) => {
  test.setTimeout(ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS + 3 * KERNEL_TIMEOUT_MS);
  await analysisResourcesFlow(page, info);
});
