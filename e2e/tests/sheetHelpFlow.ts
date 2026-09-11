import { expect, type Page, type TestInfo } from '@playwright/test';

export async function sheetHelpFlow(page: Page, title: string, testInfo: TestInfo, imageName: string): Promise<void> {
  await page.keyboard.press('F1');
  const dialog = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
  const article = dialog.getByRole('article', { name: 'ヘルプ本文', exact: true });
  await expect(article.getByRole('heading', { level: 1 })).toHaveText(title);
  const images = article.locator('img');
  await expect.poll(() => images.count()).toBeGreaterThan(0);
  // Firefoxは画面外のlazy画像をまだ読まない。利用者と同じく各画像までスクロールする。
  for (const image of await images.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement
      && element.complete && element.naturalWidth > 0), { message: `ヘルプ画像: ${await image.getAttribute('src')}` }).toBe(true);
  }
  await article.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => article.evaluate((element) => element.scrollTop)).toBe(0);
  await page.screenshot({ path: testInfo.outputPath(imageName) });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}
