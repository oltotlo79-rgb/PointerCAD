import { expect, test } from '@playwright/test';
import { compositionFlows, drawingBusyReasonProof } from './usabilityKeyboardFlow.js';
import { installDrawingRefreshHold } from './holdDrawingRefresh.js';
import { connectRefusalsFlow } from './connectRefusalsFlow.js';
import { launchDesktop } from './electronAppFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

for (const [name, flow] of compositionFlows) test(`V103 R20 実Electronの${name}で入力所有・確定・取消を保つ`, async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    if (name === '図面の文字注記') { await installDrawingRefreshHold(page); await page.reload(); }
    await waitForStartupHealth(page, info);
    await flow(page, info);
    if (name === '図面の文字注記') await drawingBusyReasonProof(page, info);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('V103 R20 実Electronの選択数・同座標・要素種類の拒否理由と文書不変を既存独立fixtureで確認', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await waitForStartupHealth(page, info);
    await connectRefusalsFlow(page, info, app);
    expect(errors).toEqual([]);
    await info.attach('r20-selection-refusals', { contentType: 'application/json', body: JSON.stringify({
      environment: info.project.name, fixture: 'connectRefusalsFlow', source: 'real PCAD file + tree selection',
      reasonVisibility: 'radial hint and refusal status asserted by existing flow', allDisabledCellsCertified: false,
    }) });
  } finally { await app.close(); }
});
