import { test } from '@playwright/test';
import { contextReferenceCycleFlow } from './contextReferenceCycleFlow.js';
import { launchDesktop } from './electronAppFlow.js';

/*
 * EX-18 W09 組立の中の参照が循環する追加と置き換え(修復)を断る(実Electron)。ブラウザーは context-reference-cycle-open.spec.ts が
 * 同じ手順(contextReferenceCycleFlow.ts)を呼ぶ。
 */
test('EX-18 W09 実Electron 組立の中の参照が循環する追加と置き換えは循環の理由を出して断り、保存した組立と Undo の履歴が変わらない', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    // 製品の入口(apps/desktop/src/main/appProtocol.ts の APP_ENTRY_URL)を開き直す(electron-face-offset.spec.ts と同じ)。
    await contextReferenceCycleFlow(await app.firstWindow(), 'app://pointercad/index.html');
  } finally { await app.close(); }
});
