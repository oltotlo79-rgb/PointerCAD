import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { PLANAR_OPERATIONS } from './planarMachiningOracle.js';
import { buildPlanarCreate, buildPlanarTwoFixture, buildPlanarMissingReference,
  planarTitle, reopenPlanarUi } from './planarMachiningFlow.js';

for (const operation of PLANAR_OPERATIONS) {
  test(planarTitle('Electron', operation, 'create'), async ({ playwright }, info) => {
    const initial = await launchDesktop(playwright, info);
    const saved = await (async () => {
      try {
        return await buildPlanarCreate(await initial.app.firstWindow(), info,
          'app://pointercad/index.html', operation, initial.app);
      } finally { await initial.app.close(); }
    })();
    const next = await launchDesktop(playwright, info);
    try { await reopenPlanarUi(await next.app.firstWindow(), info, 'app://pointercad/index.html', saved, next.app); }
    finally { await next.app.close(); }
  });
  test(planarTitle('Electron', operation, 'two-fixture'), async ({ playwright }, info) => {
    const initial = await launchDesktop(playwright, info);
    const saved = await (async () => {
      try {
        return await buildPlanarTwoFixture(await initial.app.firstWindow(), info,
          'app://pointercad/index.html', operation, initial.app);
      } finally { await initial.app.close(); }
    })();
    const next = await launchDesktop(playwright, info);
    try { await reopenPlanarUi(await next.app.firstWindow(), info, 'app://pointercad/index.html', saved, next.app); }
    finally { await next.app.close(); }
  });
}
test(planarTitle('Electron', 'plain', 'missing-reference'), async ({ playwright }, info) => {
  const initial = await launchDesktop(playwright, info);
  try {
    await buildPlanarMissingReference(await initial.app.firstWindow(), info,
      'app://pointercad/index.html', initial.app);
  } finally { await initial.app.close(); }
});
