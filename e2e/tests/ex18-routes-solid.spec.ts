import { test } from '@playwright/test';
import { EX18_A_ROUTES, ex18ARoutesFlow, ex18BRevolveFlow, EX18_B_HOLE_ROUTES, ex18BFlangeFlow, ex18CStepFlow, EX18_C_BASIC_ROUTES, ex18CObliqueFlow } from './ex18RoutesFlow.js';

for (const route of EX18_A_ROUTES) {
  test(`EX-18 A/${route}: ordinary UI construction, refusal/cancel, diameter6-to8, one Undo/Redo, saved cold native oracle`, async ({ page }, info) => {
    await ex18ARoutesFlow(page, info, '/', route);
  });
}

test('EX-18 B/a: stepped hollow section/revolve, refusal/cancel, diameter6-to8, two-coordinate Undo/Redo, saved cold native oracle', async ({ page }, info) => {
  await ex18BRevolveFlow(page, info, '/');
});

for (const route of EX18_B_HOLE_ROUTES) {
  test(`EX-18 B/${route}: ordinary UI construction, refusal/cancel, diameter6-to8, one Undo/Redo, saved cold native oracle`, async ({ page }, info) => {
    await ex18BFlangeFlow(page, info, '/', route);
  });
}

test('EX-18 C/c: actual UI STEP seed3, planar face7-to2, zero refusal/cancel, one Undo/Redo, saved cold native oracle', async ({ page }, info) => {
  await ex18CStepFlow(page, info, '/');
});

for (const route of EX18_C_BASIC_ROUTES) {
  test(`EX-18 C/${route}: ordinary UI construction, refusal/cancel, depth10-to5, one Undo/Redo, saved cold native oracle`, async ({ page }, info) => {
    await ex18CObliqueFlow(page, info, '/', route);
  });
}

