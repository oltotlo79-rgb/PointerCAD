import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { igesRoundTripFlow, plainIgesRoundTripFlow, prepareIgesInput } from './igesRoundTripFlow.js';

test('J-04 IGESの読込・点検・修繕・保存再開・書出しを実Electronで通す', async ({ playwright }, info) => {
  const input = await prepareIgesInput(info);
  const { app } = await launchDesktop(playwright, info);
  try {
    await igesRoundTripFlow(await app.firstWindow(), info, input, app);
  } finally { await app.close(); }
});

test('J-04 IGESを実Electronのファイル操作で読み込み、そのまま書き出す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    await plainIgesRoundTripFlow(await app.firstWindow(), info, app);
  } finally { await app.close(); }
});
