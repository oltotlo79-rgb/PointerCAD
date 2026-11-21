import { expect, test } from '@playwright/test';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { beamReportFlow, savedBeamResultFlow } from './beamReportFlow.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { frictionLifecycleFlow } from './frictionFlow.js';

test.describe('摩擦: 設定・実解析・保存復元(Web)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });
  test('負の係数を拒否し、4段の反力とゼロ除荷、保存と未計算の再開を確認する', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await frictionLifecycleFlow(page, name => info.outputPath(name));
    expect(errors).toEqual([]);
  });
});

// J-03c 梁の静解析の報告書: 摩擦と同じ標準の棒と保存の読み手で、静解析を流して PDF を書き出す。
test.describe('梁の静解析の報告書(Web)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });
  test('保存した静解析の入力を開いて解析し、報告書の釦で 1 頁の PDF を書き出す', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await beamReportFlow(page, name => info.outputPath(name));
    expect(errors).toEqual([]);
  });
});

// J-03b 段 1・J-03d 梁の静解析の結果の保存: 同じ標準の棒で、計算してから反映しても結果が残り、保存して開き直すと流し直さずに出る。
test.describe('梁の静解析の結果の保存(Web)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });
  test('計算してから入力を文書に反映しても結果が残り、保存して開き直すと流し直さずに出て、棒の長さを変えると消える', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await savedBeamResultFlow(page, name => info.outputPath(name));
    expect(errors).toEqual([]);
  });
});
