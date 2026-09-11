import { test, expect } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';

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
