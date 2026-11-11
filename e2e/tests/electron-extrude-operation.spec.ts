import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { extrudeOperationFlow, extrudeStaleTargetFlow } from './flows/extrudeOperationFlow.js';

for (const operation of ['new', 'join', 'cut'] as const) {
  test(`Electron extrude ${operation}: real preview cancel atomic Undo and saved geometry`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await extrudeOperationFlow(page, info, operation, app);
      expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}

test('Electron extrude stale selected target refuses without a new Undo entry', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await extrudeStaleTargetFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
