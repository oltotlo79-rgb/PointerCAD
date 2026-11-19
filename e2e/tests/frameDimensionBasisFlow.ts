/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { frameLayout } from './frameStrokeFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * 配置の補助 P-B 芯・内側・外側: 選ぶ窓の「線に沿って並べる」で、外形 520×320 の長方形の角を貼り付けて閉じ、寸法の基準を「外側」にすると、
 * 系列の溝幅 6 20×20(中心から面まで 10)の芯 500×300 で並べる。予告は突き当てで 520・300・500・280(J-01 の画面検査の 500×300 と
 * 同じ手で解いた値)、芯の基準のままなら 540・320・520・300。芯の点は 1: 10 10 0 〜 4: 10 310 0。閉じていない時は内側・外側を選べない。
 * 並べる手順は aluminumFrameCatalogFlow.ts の layoutRectangle と同じ。
 */
export function registerFrameDimensionBasisTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('P-B 芯・内側・外側の寸法', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('外形 520×320 を外側の基準で並べると、芯 500×300 で予告して芯の点を出し、4 本並べる', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
      const layout = frameLayout(page, dialog);
      await layout.locator('summary').click();
      await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
        .fill(['0\t0\t0', '520\t0\t0', '520\t320\t0', '0\t320\t0'].join('\n'));
      const basis = choice(layout, 'catalog', 'catalog.frameLayout.basis');
      // 閉じていない時は、内側・外側を選べず、理由の 1 行が出る。
      // option の disabled は、Playwright の toBeDisabled では「enabled」と読まれる(RUN 20261119-065914 で、<option disabled value="outer"> に
      // 対して Received: enabled)ので、属性で確かめる。
      await expect(basis.locator('option[value="outer"]')).toHaveAttribute('disabled', '');
      await expect(layout.getByText(uiMessage('catalog', 'catalog.frameLayout.basisUnavailable'), { exact: true })).toBeVisible();
      await layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true }).check();
      await expectPreviewLengths(layout, ['540', '320', '520', '300']);

      await basis.selectOption('outer');
      await expectPreviewLengths(layout, ['520', '300', '500', '280']);
      for (const text of ['1: 10 10 0', '2: 510 10 0', '3: 510 310 0', '4: 10 310 0']) {
        await expect(layout.getByText(text, { exact: true })).toBeVisible();
      }
      const token = await beginRecompute(page);
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
      await waitForRecompute(page, token);
      await expect(layout.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameLayout.placed').replace('{count}', '4'));
      await expect(componentRows(page)).toHaveCount(4);
      expect(errors).toEqual([]);
    });
  });
}
