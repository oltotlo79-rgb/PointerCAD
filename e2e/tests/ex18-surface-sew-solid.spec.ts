import { test } from '@playwright/test';
import { ex18SurfaceSewSolidFlow } from './ex18SurfaceSewSolidFlow.js';

test('EX-18 円筒の側面と端面を縫合し、1回のUndo・φ6貫通穴・保存と再開を通す', async ({ page }, info) => {
  await ex18SurfaceSewSolidFlow(page, info);
});
