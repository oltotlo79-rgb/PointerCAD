import { expect, test } from '@playwright/test';
import { diskFile, launchDesktop, openTarget, saveTarget } from './electronAppFlow.js';
import { parameterSearchCsvFlow, type ParameterCsvIo } from './parameterSearchCsvFlow.js';

/** 実 Electron。ファイルダイアログだけを選んだ道筋へ差し替え、読込・書出は製品の経路(IPC)を通す。 */
test('R12/R13 実Electronで100行のパラメータを検索・絞込し、CSV を往復・確認・取消・上限まで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  const io: ParameterCsvIo = {
    async importFile(_page, button, path) { await openTarget(app, path); await button.click(); },
    async exportFile(_page, button, path) { await saveTarget(app, path); await button.click(); return diskFile(path); },
  };
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await parameterSearchCsvFlow(page, info, io);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
