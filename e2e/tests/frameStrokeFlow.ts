/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-08 一筆書きの配置: フレームの一括配置の窓で線の決め方を「3D の画面で点を打つ」にし、3D の画面で箱の上の面の頂点を順に押す。
 * 頂点の世界の座標は、同じ窓の「選んだ部品のまっすぐな辺から」の一覧の中点から読む(上の面の 4 辺の中点の X・Y の最小と最大が、
 * 上の面の頂点の X・Y。箱は 1 辺 20 mm〔既定の箱の大きさ〕)。
 * 等角の視点では、上の面の右手前の頂点は下の面の左奥の頂点と画面で重なる(頂点の当たりは深度を見ない)ので押さない。
 * 押すのは左手前 A・左奥 D・右奥 C の 3 つで、線 A→D(Y の向きに 20)と D→C(X の向きに 20)になる(手で解いた値)。
 */
type Point = readonly [number, number, number];

export function frameLayout(page: Page, dialog: Locator): Locator {
  return dialog.locator('details').filter({
    has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
  });
}

/** 辺の一覧(「中点 (x, y, z)」で終わる行)から、上の面の頂点 A(左手前)・D(左奥)・C(右奥)を読む。 */
export async function topCorners(layout: Locator): Promise<{ readonly a: Point; readonly d: Point; readonly c: Point }> {
  await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('edges');
  await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.loadEdges'), exact: true }).click();
  await expect(layout.getByRole('checkbox')).toHaveCount(12);
  const midpoints = (await layout.locator('li').allInnerTexts()).map((text): Point => {
    const match = /\(([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+)\)\s*$/u.exec(text);
    return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  });
  const z = Math.max(...midpoints.map(point => point[2]));
  const top = midpoints.filter(point => point[2] === z);
  expect(top).toHaveLength(4);
  const xs = top.map(point => point[0]), ys = top.map(point => point[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  expect([x1 - x0, y1 - y0]).toEqual([20, 20]);
  return { a: [x0, y0, z], d: [x0, y1, z], c: [x1, y1, z] };
}

export function registerFrameStrokeTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-08 一筆書きの配置', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('3D の画面で箱の上の面の頂点を順に押すと点の欄に入り、Backspace で消え、最初の点で閉じ、2 本を予告して 1 回で並べ、Undo 1 回で戻る',
      async ({ page }, info: TestInfo) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const app = appForPage(page);
        await startAssembly(page, app);
        const fixturePath = info.outputPath('two-box-stroke.pcada');
        await writeFile(fixturePath, await twoBoxAssemblyFile(40));
        await openSaveFlowFile(page, fixturePath, app);
        await expect(componentRows(page)).toHaveCount(2);
        await goHome(page);
        await componentRows(page).nth(0).click();

        const dialog = await openFramePicker(page);
        await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
        const layout = frameLayout(page, dialog);
        await layout.locator('summary').click();
        const { a, d, c } = await topCorners(layout);

        await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('stroke');
        const points = layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true });
        const closed = layout.getByRole('checkbox', { name: uiMessage('catalog', 'catalog.frameLayout.closed'), exact: true });
        const status = (count: number): Locator => layout.getByText(
          uiMessage('catalog', 'catalog.frameLayout.stroke.active').replace('{count}', String(count)), { exact: true });
        await expect(status(0)).toBeVisible();
        await clickWorldPointChecked(page, a);
        await clickWorldPointChecked(page, d);
        await expect(status(2)).toBeVisible();
        // 焦点はビューにあるので、Backspace は最後の点を消す。
        await page.keyboard.press('Backspace');
        await expect(status(1)).toBeVisible();
        await clickWorldPointChecked(page, d);
        await clickWorldPointChecked(page, c);
        await expect(status(3)).toBeVisible();
        await expect(points).toHaveValue([a, d, c].map(point => point.join(' ')).join('\n'));
        // 3 点の後に最初の点を押し直すと閉じる(点は増えない)。Backspace は閉じるのをやめる。
        await clickWorldPointChecked(page, a);
        await expect(closed).toBeChecked();
        await expect(status(3)).toBeVisible();
        await page.keyboard.press('Backspace');
        await expect(closed).not.toBeChecked();

        await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('none');
        await expectPreviewLengths(layout, ['20', '20']);
        const token = await beginRecompute(page);
        await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
        await waitForRecompute(page, token);
        await expect(layout.getByRole('status')).toHaveText(uiMessage('catalog', 'catalog.frameLayout.placed').replace('{count}', '2'));
        await expect(componentRows(page)).toHaveCount(4);
        // 置いたら点の列を空にして、続けて次の線を打てる。
        await expect(points).toHaveValue('');
        await expect(status(0)).toBeVisible();

        await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
        const undo = await beginRecompute(page);
        await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
        await waitForRecompute(page, undo);
        await expect(componentRows(page)).toHaveCount(2);
        expect(errors).toEqual([]);
      });
  });
}
