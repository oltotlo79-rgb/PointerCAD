import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { frictionCancelFlow } from './frictionCancelFlow.js';

test('cancel running work, review and solve all four friction stages (Electron)', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await frictionCancelFlow(page, name => join(directory, name), app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
