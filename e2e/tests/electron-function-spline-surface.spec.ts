import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { functionSplineSurfaceFlow, functionSurfaceReplyCancellationFlow } from './functionSplineSurfaceFlow.js';

for (const [name, run] of [
  ['SMOOTH-SURFACE native CAD surface, XYZ, stale preview, save reopen, update and Undo', functionSplineSurfaceFlow],
  ['SMOOTH-SURFACE bounded large reply, trusted Stop, cancel and fresh owner', functionSurfaceReplyCancellationFlow],
] as const) {
  test(name, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await run(page, info, app); expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}
