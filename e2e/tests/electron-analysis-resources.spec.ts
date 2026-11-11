import { test } from '@playwright/test';
import { ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS } from './assembly1000HostFlow.js';
import { launchDesktop } from './electronAppFlow.js';
import { KERNEL_TIMEOUT_MS } from './recompute.js';
import { analysisResourcesFlow } from './analysisResourcesFlow.js';

test('Electron: 1000 CAD components and separately bounded real single-solid FEM', async ({ playwright }, info) => {
  test.setTimeout(ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS + 3 * KERNEL_TIMEOUT_MS);
  const { app } = await launchDesktop(playwright, info);
  try { await analysisResourcesFlow(await app.firstWindow(), info, app); }
  finally { await app.close(); }
});
