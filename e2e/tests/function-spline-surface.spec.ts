import { expect, test } from '@playwright/test';
import { functionSplineSurfaceFlow, functionSurfaceReplyCancellationFlow } from './functionSplineSurfaceFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });
for (const [name, run] of [
  ['SMOOTH-SURFACE native CAD surface, XYZ, stale preview, save reopen, update and Undo', functionSplineSurfaceFlow],
  ['SMOOTH-SURFACE bounded large reply, trusted Stop, cancel and fresh owner', functionSurfaceReplyCancellationFlow],
] as const) {
  test(name, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await run(page, info); expect(errors).toEqual([]);
  });
}
