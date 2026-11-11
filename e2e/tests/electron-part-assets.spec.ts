import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { partAssetLifetimeFlow } from './partAssetLifetimeFlow.js';

test('実Electron BRepとmeshの所有は部品をまたぐUndo・保存再開でも保たれる', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try { await partAssetLifetimeFlow(await app.firstWindow(), info, app); }
  finally { await app.close(); }
});
