import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { faceOffsetFlow, pushPullFlow } from './faceOffsetFlow.js';

test('EX-18 実Electron 穴のある板の端面を符号付きで動かし、寸法の変更・元に戻す・保存と開き直し・衝突の断りと修正後の1回確定・失敗履歴の元形状が実物で通る', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    // 製品の入口(apps/desktop/src/main/appProtocol.ts の APP_ENTRY_URL)を開き直す(Root の3 host の検査と同じ)。
    await faceOffsetFlow(await app.firstWindow(), info, 'app://pointercad/index.html');
  } finally { await app.close(); }
});

test('実Electron 押し引き(M-05): 作図の面・立体の面・辺・穴の壁を加工に渡す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    await pushPullFlow(await app.firstWindow(), 'app://pointercad/index.html');
  } finally { await app.close(); }
});
