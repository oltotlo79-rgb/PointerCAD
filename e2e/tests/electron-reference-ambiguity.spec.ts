import { expect, test, type ElectronApplication } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { referenceAmbiguityFlow, referenceRepairAppearanceFlow, referenceRepairNativePreviewFlow, referenceRepairDrawingFlow, referenceRepairDrawingColdFlow, type ReferenceAmbiguityUse } from './referenceAmbiguityFlow.js';

const CASES: readonly { readonly title: string; readonly use: ReferenceAmbiguityUse }[] = [
  { title: '寸法', use: 'dimension' },
  { title: '合致', use: 'mate' },
  { title: '加工面(穴)', use: 'machining' },
  { title: '外観', use: 'appearance' },
];

for (const { title, use } of CASES) {
  test(`実Electronで曖昧・消失した参照を正常な値として採らず、元の参照を保つ: ${title}`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', error => { errors.push(error.message); });
      expect(page.url()).toBe('app://pointercad/index.html');
      await referenceAmbiguityFlow(page, info, use, { app });
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
}


test('実Electron R17 外観の参照修復はhover/取消不変・世代拒否・確定1履歴・保存再開を保つ', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    expect(page.url()).toBe('app://pointercad/index.html');
    await referenceRepairAppearanceFlow(page, info, { app });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

for (const use of ['part', 'assembly'] as const) {
  test(`実Electron R17 非表示元形状のpreview owner・outline・clear・取消・世代・保存: ${use}`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      expect(page.url()).toBe('app://pointercad/index.html');
      await referenceRepairNativePreviewFlow(page, info, use, { app });
      expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}

test('実Electron R17 実図面の参照修復は2操作候補・投影edge hover取消不変・確定1履歴・世代拒否・不能理由・保存冷再開を保つ', async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info);
  let active: ElectronApplication | null = first.app;
  try {
    const firstPage = await first.app.firstWindow(), errors: string[] = [];
    firstPage.on('pageerror', error => errors.push(error.message));
    expect(firstPage.url()).toBe('app://pointercad/index.html');
    const saved = await referenceRepairDrawingFlow(firstPage, info, { app: first.app });
    expect(errors).toEqual([]);
    await first.app.close(); active = null;
    const second = await launchDesktop(playwright, info); active = second.app;
    const fresh = await second.app.firstWindow(), freshErrors: string[] = [];
    fresh.on('pageerror', error => freshErrors.push(error.message));
    expect(fresh.url()).toBe('app://pointercad/index.html');
    await referenceRepairDrawingColdFlow(fresh, info, saved, second.app);
    expect(freshErrors).toEqual([]);
  } finally { if (active !== null) await active.close(); }
});
