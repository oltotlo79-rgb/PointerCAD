import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { referenceAmbiguityFlow, referenceRepairAppearanceFlow, referenceRepairNativePreviewFlow, referenceRepairDrawingFlow, referenceRepairDrawingColdFlow, type ReferenceAmbiguityUse } from './referenceAmbiguityFlow.js';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';

const CASES: readonly { readonly title: string; readonly use: ReferenceAmbiguityUse; readonly mirror?: boolean }[] = [
  { title: '寸法', use: 'dimension' },
  { title: '寸法(候補の番号の並びを入れ替えた形)', use: 'dimension', mirror: true },
  { title: '合致', use: 'mate' },
  { title: '加工面(穴)', use: 'machining' },
  { title: '外観', use: 'appearance' },
];

for (const { title, use, mirror } of CASES) {
  test(`R01 曖昧・消失した参照を正常な値として採らず、元の参照を保つ: ${title}`, async ({ page }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await installStartupDiagnostics(page);
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await waitForStartupHealth(page, info);
    await referenceAmbiguityFlow(page, info, use, mirror === undefined ? {} : { mirror });
    expect(errors).toEqual([]);
  });
}


test('R17 外観の参照修復はhover/取消不変・世代拒否・確定1履歴・保存再開を保つ', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
  });
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await referenceRepairAppearanceFlow(page, info);
  expect(errors).toEqual([]);
});

for (const use of ['part', 'assembly'] as const) {
  test(`R17 実非表示元形状のpreview owner・outline・clear・取消・世代・保存: ${use}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await installStartupDiagnostics(page);
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await waitForStartupHealth(page, info);
    await referenceRepairNativePreviewFlow(page, info, use);
    expect(errors).toEqual([]);
  });
}

/** Exact project launch/context limits, two actually closed/started browser processes. */
async function withDrawingColdPage<T>(browser: Browser, info: TestInfo, run: (page: Page) => Promise<T>): Promise<T> {
  const use = info.project.use;
  const context = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport, userAgent: use.userAgent,
    deviceScaleFactor: use.deviceScaleFactor, isMobile: use.isMobile, hasTouch: use.hasTouch,
    locale: use.locale, colorScheme: use.colorScheme, acceptDownloads: use.acceptDownloads });
  try {
    context.setDefaultTimeout(use.actionTimeout ?? 0);
    context.setDefaultNavigationTimeout(use.navigationTimeout ?? 0);
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await installStartupDiagnostics(page);
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    });
    await page.goto('/'); await waitForStartupHealth(page, info);
    const result = await run(page);
    expect(errors).toEqual([]);
    return result;
  } finally { await context.close(); }
}

test('R17 実図面の参照修復は2操作候補・投影edge hover取消不変・確定1履歴・世代拒否・不能理由・保存冷再開を保つ', async ({ playwright, browserName }, info) => {
  const use = info.project.use;
  const launch = () => playwright[browserName].launch({ ...use.launchOptions,
    ...(use.headless === undefined ? {} : { headless: use.headless }), ...(use.channel === undefined ? {} : { channel: use.channel }) });
  const first = await launch();
  let saved: Awaited<ReturnType<typeof referenceRepairDrawingFlow>>;
  try { saved = await withDrawingColdPage(first, info, page => referenceRepairDrawingFlow(page, info)); }
  finally { await first.close(); }
  expect(first.isConnected()).toBe(false);
  const second = await launch();
  try { await withDrawingColdPage(second, info, page => referenceRepairDrawingColdFlow(page, info, saved)); }
  finally { await second.close(); }
  expect(second.isConnected()).toBe(false);
});
