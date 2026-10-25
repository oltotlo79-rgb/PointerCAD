import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { assemblyCoupledDragFlow } from './assemblyCoupledDragFlow.js';
import { ORACLE_RATIOS } from './assemblyMechanismOracleFixture.js';
import { assemblyMechanismOracleFlow, assemblyMechanismRefusalFlow } from './assemblyMechanismOracleFlow.js';

/** The same viewport drag flow in the desktop app (files through the app's own open/save targets). */
test('EX12 dragging a cross-level coupled parent in the viewport of the desktop app', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await assemblyCoupledDragFlow(page, info, app);
  } finally {
    await app.close();
  }
});

for (const ratio of ORACLE_RATIOS) {
  test(`EX12 desktop exact angle field: ratio ${String(ratio)}, phase and both half-turn boundaries`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      await page.setViewportSize({ width: 1440, height: 900 });
      await assemblyMechanismOracleFlow(page, info, app, ratio);
    } finally {
      await app.close();
    }
  });
}

test('EX12 desktop rejects contradictory phase and missing reference files and recovers', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await assemblyMechanismRefusalFlow(page, info, app);
  } finally {
    await app.close();
  }
});
