import { test } from '@playwright/test';
import { ADDITIONAL_MACHINING_CASES, buildSurfaceMachining, machiningTitle, reopenSurfaceMachining,
  buildTwoLocationMachining, reopenTwoLocationMachining, twoLocationTitle } from './machiningSurfaceFlow.js';
import { TWO_LOCATION_OPERATIONS } from './machiningSurfaceOracle.js';


// Plane/plain-through baseline reuses Root-accepted EX18 A/a; retain v1 delta code in the Flow.
for (const scenario of ADDITIONAL_MACHINING_CASES) {
  test(machiningTitle('Web', scenario), async ({ page }, info) => {
    const saved = await buildSurfaceMachining(page, info, '/', scenario);
    const reopened = await page.context().newPage();
    try { await reopenSurfaceMachining(reopened, info, '/', saved); }
    finally { await reopened.close(); }
  });
}

for (const operation of TWO_LOCATION_OPERATIONS) {
  test(twoLocationTitle('Web', operation), async ({ page }, info) => {
    const saved = await buildTwoLocationMachining(page, info, '/', operation);
    const reopened = await page.context().newPage();
    try { await reopenTwoLocationMachining(reopened, info, '/', saved); }
    finally { await reopened.close(); }
  });
}
