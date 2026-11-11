import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { shellAnalysisPersistenceFlow, shellAnalysisSolidRefusalFlow } from './shellAnalysisPersistenceFlow.js';

const DESKTOP_URL = 'app://pointercad/index.html';

test('実Electronの薄板の解析: 平面シートの純曲げを実Workerで解き、保存・開き直し・再実行・条件変更を通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    await shellAnalysisPersistenceFlow(await app.firstWindow(), info, DESKTOP_URL, app);
  } finally { await app.close(); }
});

test('実Electronの薄板の解析: ソリッドの箱は理由を表示し、FEM Workerを起動しない', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    await shellAnalysisSolidRefusalFlow(await app.firstWindow(), info, DESKTOP_URL, app);
  } finally { await app.close(); }
});
