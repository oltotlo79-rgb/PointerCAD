import { test } from '@playwright/test';
import { PLANAR_OPERATIONS } from './planarMachiningOracle.js';
import { buildPlanarCreate, buildPlanarTwoFixture, buildPlanarMissingReference,
  planarTitle, reopenPlanarUi } from './planarMachiningFlow.js';

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
}
test(planarTitle('Web', 'plain', 'missing-reference'), async ({ page }, info) => {
  await buildPlanarMissingReference(page, info, '/');
});
