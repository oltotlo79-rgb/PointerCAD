import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { controlHintsFlow } from './controlHintsFlow.js';

test('P12-5 実Electronでキー移動の説明・入力保全・150%表示を通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try { await controlHintsFlow(await app.firstWindow(), info); }
  finally { await app.close(); }
});

test('P12-2・3 実Electronで全ての説明章と画像を開き、検索・F1後も入力と保存文書を保つ', async ({ playwright }, info) => {
  const { helpReaderFlow } = await import('./helpReaderFlow.js');
  const { app } = await launchDesktop(playwright, info);
  try { await helpReaderFlow(await app.firstWindow(), info, app); }
  finally { await app.close(); }
});
