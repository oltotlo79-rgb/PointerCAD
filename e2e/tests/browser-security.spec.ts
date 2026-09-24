import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { withBrowserFailureDiagnostics } from './browserFailureDiagnostics.js';

test('画面のinline scriptとevalを拒否し、外部送信を許可しない（R11）', async ({ page }) => {
  await page.goto('/');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^作る/ }).first().click();
  await page.getByRole('group', { name: '作る', exact: true }).getByRole('button', { name: '箱', exact: true }).click();
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-statusbar')).not.toContainText('計算に失敗しました');
  if (await page.locator('.pcad-popover').count()) await page.locator('.pcad-popover input').first().press('Escape');
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'document.documentElement.setAttribute("data-inline-executed", "yes")';
    document.head.append(script);
    script.remove();
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-inline-executed');

  // evaluateのJS実行自身は自動化用の権限を持つので、その中のeval拒否を測定しない。
  // 正規のsame-origin scriptとして読み、通常ページのCSPによるeval拒否を観測する。
  await page.route('**/assets/csp-eval-probe.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `try {
      Function('document.documentElement.setAttribute("data-eval-executed", "yes")')();
    } catch (error) {
      document.documentElement.setAttribute('data-eval-rejected', error.name);
    }`,
  }));
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/assets/csp-eval-probe.js';
    script.onload = () => { script.remove(); resolve(); };
    script.onerror = () => { script.remove(); reject(new Error('probe scriptを読み込めません')); };
    document.head.append(script);
  }));
  await expect(page.locator('html')).not.toHaveAttribute('data-eval-executed');
  await expect(page.locator('html')).toHaveAttribute('data-eval-rejected', 'EvalError');

  const external = await page.evaluate(() => new Promise<string>((resolve) => {
    const url = 'https://pointercad-security-test.invalid/blocked';
    const finish = (reason: string): void => {
      clearTimeout(timer);
      document.removeEventListener('securitypolicyviolation', onViolation);
      resolve(reason);
    };
    const onViolation = (event: SecurityPolicyViolationEvent): void => {
      // CSPは外部URIのpathを省いてoriginだけを報告することがある。
      if (event.blockedURI === url || event.blockedURI === new URL(url).origin) finish(event.effectiveDirective);
    };
    const timer = setTimeout(() => finish('no-csp-violation'), 3_000);
    document.addEventListener('securitypolicyviolation', onViolation);
    void fetch(url).then(() => finish('allowed'), () => { /* 拒否理由はCSPイベントで判定する。 */ });
  }));
  expect(external).toBe('connect-src');
  await page.locator('.pcad-toolbar').getByRole('button', { name: /^ファイル/ }).first().click();
  await page.getByRole('button', { name: 'この部品から図面を作成', exact: true }).click();
  await expect.poll(() => page.locator('.pcad-drawing-svg [data-owner-id="view-1"] path').evaluateAll((elements) =>
    elements.reduce((sum, element) => sum + (element instanceof SVGPathElement ? element.getTotalLength() : 0), 0)),
  { timeout: 60_000 }).toBeGreaterThan(0);
});

test('終了診断は実際の画面終了を残し、元の不一致を上書きしない', async ({ page }, info) => {
  const before = info.attachments.length;
  await withBrowserFailureDiagnostics(page, info, async (stage) => {
    stage('正常な読み取り');
    expect(await page.title()).toBe('');
  });
  expect(info.attachments).toHaveLength(before);
  const failure = new Error('確認用の元の不一致');
  await expect(withBrowserFailureDiagnostics(page, info, async (stage) => {
    stage('確認用の画面終了');
    await page.close();
    throw failure;
  })).rejects.toBe(failure);
  const attachment = info.attachments.filter((entry) => entry.name === 'browser-failure-diagnostics').at(-1);
  if (attachment === undefined) throw new Error('終了診断が保存されていません');
  const text = attachment.body?.toString('utf8') ?? await readFile(attachment.path ?? '', 'utf8');
  const diagnostic: unknown = JSON.parse(text);
  expect(diagnostic).toMatchObject({ stage: '確認用の画面終了', lifecycle: [
    { event: 'page-closed', stage: '確認用の画面終了' },
  ] });
});

test('終了診断は実際のブラウザー切断を成功扱いせずに保存する', async ({ playwright, browserName }, info) => {
  // Only this owned, blank browser is closed; the test runner's browser stays alive.
  const browser = await playwright[browserName].launch({ headless: true });
  try {
    const page = await browser.newPage();
    await expect(withBrowserFailureDiagnostics(page, info, async (stage) => {
      stage('確認用のブラウザー終了');
      await browser.close();
    })).rejects.toThrow('操作中に画面またはブラウザーが終了しました');
    const attachment = info.attachments.filter((entry) => entry.name === 'browser-failure-diagnostics').at(-1);
    if (attachment === undefined) throw new Error('切断の診断が保存されていません');
    const text = attachment.body?.toString('utf8') ?? await readFile(attachment.path ?? '', 'utf8');
    const diagnostic: unknown = JSON.parse(text);
    // lifecycle の各要素は browserFailureDiagnostics.ts が freeHostMemoryBytes・testWorkerRssBytes
    // も持たせる。arrayContaining内の素のobjectは深い等価比較になり追加フィールドで不一致になるため、
    // objectContainingで必要な3項目だけを検査し、正しい記録を追加情報を理由に拒否しない。
    expect(diagnostic).toMatchObject({ stage: '確認用のブラウザー終了', lifecycle: expect.arrayContaining([
      expect.objectContaining({ event: 'browser-disconnected', stage: '確認用のブラウザー終了', elapsedMs: expect.any(Number) }),
    ]) });
  } finally {
    await browser.close();
  }
});
