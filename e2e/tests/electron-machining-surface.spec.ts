import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { ADDITIONAL_MACHINING_CASES, buildSurfaceMachining, machiningTitle, reopenSurfaceMachining,
  buildTwoLocationMachining, reopenTwoLocationMachining, twoLocationTitle } from './machiningSurfaceFlow.js';
import { TWO_LOCATION_OPERATIONS } from './machiningSurfaceOracle.js';


// Plane/plain-through baseline reuses Root-accepted EX18 A/a; retain v1 delta code in the Flow.
for (const scenario of ADDITIONAL_MACHINING_CASES) {
  test(machiningTitle('Electron', scenario), async ({ playwright }, info) => {
    const initial = await launchDesktop(playwright, info);
    const saved = await (async () => {
      try { return await buildSurfaceMachining(await initial.app.firstWindow(), info, 'app://pointercad/index.html', scenario, initial.app); }
      finally { await initial.app.close(); }
    })();
    const reopened = await launchDesktop(playwright, info);
    try { await reopenSurfaceMachining(await reopened.app.firstWindow(), info, 'app://pointercad/index.html', saved, reopened.app); }
    finally { await reopened.app.close(); }
  });
}

for (const operation of TWO_LOCATION_OPERATIONS) {
  test(twoLocationTitle('Electron', operation), async ({ playwright }, info) => {
    const initial = await launchDesktop(playwright, info);
    const saved = await (async () => {
      try { return await buildTwoLocationMachining(await initial.app.firstWindow(), info, 'app://pointercad/index.html', operation, initial.app); }
      finally { await initial.app.close(); }
    })();
    const reopened = await launchDesktop(playwright, info);
    try { await reopenTwoLocationMachining(await reopened.app.firstWindow(), info, 'app://pointercad/index.html', saved, reopened.app); }
    finally { await reopened.app.close(); }
  });
}
