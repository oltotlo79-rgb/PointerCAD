import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { EX18_A_ROUTES, ex18ARoutesFlow, ex18BRevolveFlow, EX18_B_HOLE_ROUTES, ex18BFlangeFlow, ex18CStepFlow, EX18_C_BASIC_ROUTES, ex18CObliqueFlow } from './ex18RoutesFlow.js';

for (const route of EX18_A_ROUTES) {
  test(`EX-18 Electron A/${route}: ordinary UI construction, refusal/cancel, diameter6-to8, one Undo/Redo, saved cold native oracle`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await ex18ARoutesFlow(await app.firstWindow(), info, 'app://pointercad/index.html', route, app); }
    finally { await app.close(); }
  });
}

test('EX-18 Electron B/a: stepped hollow section/revolve, refusal/cancel, diameter6-to8, two-coordinate Undo/Redo, saved cold native oracle', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try { await ex18BRevolveFlow(await app.firstWindow(), info, 'app://pointercad/index.html', app); }
  finally { await app.close(); }
});

for (const route of EX18_B_HOLE_ROUTES) {
  test(`EX-18 Electron B/${route}: ordinary UI construction, refusal/cancel, diameter6-to8, one Undo/Redo, saved cold native oracle`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await ex18BFlangeFlow(await app.firstWindow(), info, 'app://pointercad/index.html', route, app); }
    finally { await app.close(); }
  });
}

test('EX-18 Electron C/c: actual UI STEP seed3, planar face7-to2, zero refusal/cancel, one Undo/Redo, saved cold native oracle', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try { await ex18CStepFlow(await app.firstWindow(), info, 'app://pointercad/index.html', app); }
  finally { await app.close(); }
});

for (const route of EX18_C_BASIC_ROUTES) {
  test(`EX-18 Electron C/${route}: ordinary UI construction, refusal/cancel, depth10-to5, one Undo/Redo, saved cold native oracle`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try { await ex18CObliqueFlow(await app.firstWindow(), info, 'app://pointercad/index.html', route, app); }
    finally { await app.close(); }
  });
}

