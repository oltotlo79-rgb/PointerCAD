import { expect, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { readRecomputeStats } from './recompute.js';

export async function dwgFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => page.evaluate(() => typeof window.pcadRecomputeStats)).toBe('function');
  const before = await readRecomputeStats(page);
  let chooserCount = 0;
  const opened = (): void => { chooserCount += 1; };
  page.on('filechooser', opened);
  try {
    await chooseToolMenuItem(page, 'ファイルのほかの操作', '読み込む');
    const panel = page.getByRole('form', { name: '読み込み', exact: true });
    await expect(panel.getByRole('button', { name: 'DXF', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'DWG (変換が必要)', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('直接読み書きできません');
    await expect(panel.getByRole('button', { name: '変換したDXFを選ぶ', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('dwg-conversion-guide.png') });
    await panel.getByRole('button', { name: 'DWGをDXFへ変換する手順', exact: true }).click();
    const help = page.getByRole('dialog', { name: 'PointerCAD ヘルプ', exact: true });
    await expect(help.getByRole('heading', { level: 1 })).toHaveText('DXF を読み書きする');
    const section = help.getByRole('heading', { name: 'DWGのファイルを持っているとき', exact: true });
    await section.scrollIntoViewIfNeeded();
    const picture = help.getByRole('img', { name: 'DWGを選ぶと、変換手順と変換済みDXFを選ぶ入口が表示される', exact: true });
    await picture.scrollIntoViewIfNeeded();
    await expect.poll(() => picture.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(help.getByRole('link', { name: /ODA DWG-DXF Converter/u })).toHaveAttribute('href', 'https://www.opendesign.com/guestfiles/oda_file_converter');
    await page.screenshot({ path: info.outputPath('dwg-help.png') });
    await page.keyboard.press('Escape'); await expect(help).toHaveCount(0);
    await panel.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(panel).toHaveCount(0);
    expect(chooserCount).toBe(0); expect(await readRecomputeStats(page)).toEqual(before);
  } finally { page.off('filechooser', opened); }
}
