import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { ex18SurfaceSewSolidFlow } from './ex18SurfaceSewSolidFlow.js';

test('EX-18 実Electronで円筒の側面と端面を縫合し、1回のUndo・φ6貫通穴・保存と再開を通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    await ex18SurfaceSewSolidFlow(await app.firstWindow(), info, 'app://pointercad/index.html', app);
  } finally { await app.close(); }
});
