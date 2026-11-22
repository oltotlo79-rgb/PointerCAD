import { test } from './browserLifecycle.testSupport.js';
import { PLANAR_OPERATIONS } from './planarMachiningOracle.js';
import { buildPlanarCreate, buildPlanarEdgeDistance, buildPlanarEdgePairFirst, buildPlanarTwoFixture, buildPlanarMissingReference,
  buildPlanarEdgeDistanceCollapse, planarTitle, reopenPlanarUi } from './planarMachiningFlow.js';

for (const operation of PLANAR_OPERATIONS) {
  test(planarTitle('Web', operation, 'create'), async ({ page }, info) => {
    const saved = await buildPlanarCreate(page, info, '/', operation);
    const reopened = await page.context().newPage();
    try { await reopenPlanarUi(reopened, info, '/', saved); }
    finally { await reopened.close(); }
  });
  test(planarTitle('Web', operation, 'two-fixture'), async ({ page }, info) => {
    const saved = await buildPlanarTwoFixture(page, info, '/', operation);
    const reopened = await page.context().newPage();
    try { await reopenPlanarUi(reopened, info, '/', saved); }
    finally { await reopened.close(); }
  });
  test(planarTitle('Web', operation, 'edge-distance'), async ({ page }, info) => {
    const saved = await buildPlanarEdgeDistance(page, info, '/', operation);
    const reopened = await page.context().newPage();
    try { await reopenPlanarUi(reopened, info, '/', saved); }
    finally { await reopened.close(); }
  });
}
test(planarTitle('Web', 'plain', 'missing-reference'), async ({ page }, info) => {
  await buildPlanarMissingReference(page, info, '/');
});
test(planarTitle('Web', 'plain', 'edge-pair-first'), async ({ page }, info) => {
  await buildPlanarEdgePairFirst(page, info, '/', 'plain');
});
test('M-10 Web edge-distance: collapse during selection and confirm a hole with Enter', async ({ page }, info) => {
  await buildPlanarEdgeDistanceCollapse(page, info, '/');
});
