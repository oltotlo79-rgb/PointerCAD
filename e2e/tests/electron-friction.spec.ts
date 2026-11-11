import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { frictionLifecycleFlow } from './frictionFlow.js';

test('摩擦: 負の係数を拒否し、4段の反力とゼロ除荷、保存と未計算の再開を確認する(Electron)', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await frictionLifecycleFlow(page, name => join(directory, name), app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
