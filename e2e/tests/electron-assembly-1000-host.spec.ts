import { expect, test } from '@playwright/test';
import { ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS, assembly1000HostFlow } from './assembly1000HostFlow.js';
import { launchDesktop } from './electronAppFlow.js';

/**
 * Own limit of this one test, for the reason written in assembly-1000-host.spec.ts (the config default stays 180 s).
 * launchDesktop already starts the app on the SwiftShader WebGL path that the real-drawing judgement checks.
 */

/** The same 1000-definition host flow in the desktop app (files through the app's own open/save dialogs). */
test('EX12 W01 1000 distinct real shapes in the desktop app: open, draw, drive two groups, save and reopen', async ({ playwright }, info) => {
  // Share the finite 600 s + five 300 s observation budget with the flow.
  test.setTimeout(ASSEMBLY_1000_FUNCTIONAL_TIMEOUT_MS);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await assembly1000HostFlow(page, info, app);
  } finally {
    await app.close();
  }
});
