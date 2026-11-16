import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { waitForStartupHealth } from './startupHealth.js';
import { touchDrawingFlow, touchViewFlow } from './touchViewFlow.js';

test('B-08g・B-08h 実Electronのタッチの指: 割当なしは今どおり、2 本指・つまむ・1 本指で視点が動き、軽く触れると点は 1 つ、再読み込みの後も残り既定に戻せる', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await touchViewFlow(page, info, async () => { await page.reload(); await waitForStartupHealth(page, info); }, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('B-08g 実Electronのタッチの指: 図面で 2 本指の平行移動とつまむが紙を動かす', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await touchDrawingFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
