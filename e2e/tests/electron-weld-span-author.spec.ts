import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { weldSpanAuthorFlow, type WeldSpanAuthorCase } from './weldSpanAuthorFlow.js';

for (const mode of ['span-span', 'section-span', 'irregular-group'] satisfies readonly WeldSpanAuthorCase[]) {
  test(`Electron weld span author: ${mode}`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      await weldSpanAuthorFlow(page, info, mode, app);
    } finally { await app.close(); }
  });
}
