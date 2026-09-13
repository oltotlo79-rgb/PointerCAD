import { expect, type Page } from '@playwright/test';
import { uiMessage } from './uiMessages.js';

/** Exercise the same reader from Web and Electron while a function dialog remains underneath. */
export async function helpNavigationFlow(page: Page): Promise<void> {
  const help = page.locator('.pcad-help'), article = help.locator('article');
  const contents = help.getByRole('navigation', { name: uiMessage('help', 'help.contents'), exact: true });
  const history = help.getByRole('navigation', { name: uiMessage('help', 'help.history'), exact: true });
  const back = history.getByRole('button', { name: uiMessage('help', 'help.back'), exact: true });
  const forward = history.getByRole('button', { name: uiMessage('help', 'help.forward'), exact: true });
  await expect(back).toBeDisabled(); await expect(forward).toBeDisabled();
  await article.hover(); await page.mouse.wheel(0, 360);
  await expect.poll(() => article.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  const scrollTop = await article.evaluate(async element => {
    let previous = element.scrollTop, steady = 0;
    const deadline = performance.now() + 5_000;
    while (steady < 3) {
      if (performance.now() > deadline) throw new Error('Help scrolling did not settle');
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = element.scrollTop;
      steady = current === previous ? steady + 1 : 0; previous = current;
    }
    return previous;
  });
  await contents.getByRole('button', { name: '関数上に座標を指定して点を作る', exact: true }).click();
  await expect(article.getByRole('heading', { name: '関数上に座標を指定して点を作る', exact: true })).toBeVisible();
  await back.click();
  await expect(article.getByRole('heading', { name: '関数とXYZの範囲から曲面を作る', exact: true })).toHaveCount(1);
  await expect.poll(async () => Math.abs(await article.evaluate(element => element.scrollTop) - scrollTop)).toBeLessThan(2);
  await forward.click();
  await expect(article.getByRole('heading', { name: '関数上に座標を指定して点を作る', exact: true })).toBeVisible();
  await back.click();
  await contents.getByRole('button', { name: '関数とXYZの範囲から曲線を作る', exact: true }).click();
  await expect(forward).toBeDisabled();
  await contents.getByRole('button', { name: '関数とXYZの範囲から曲面を作る', exact: true }).click();
  await expect(article.getByRole('heading', { name: '関数とXYZの範囲から曲面を作る', exact: true })).toBeVisible();
}
