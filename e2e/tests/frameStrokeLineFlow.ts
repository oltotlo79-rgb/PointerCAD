/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome } from './boltedJointTestSupport.js';
import { frameLayout, topCorners } from './frameStrokeFlow.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * E-08 第 2 段 3D の一時の線: 一筆書きで打った点と、点を結ぶ線を 3D の画面に出す。画素の色ではなく、検査専用の口
 * (window.pcadViewportFrameStroke。描いている点の数・線の本数・閉じているか)で確かめる。
 * 箱の上の面の頂点 A(左手前)・D(左奥)・C(右奥)を押す(E-08 の画面検査と同じ 3 点。右手前は等角の視点で下の面の頂点と重なるので押さない)。
 * 3 点で線 2 本、A を押し直して閉じると 3 本。「打つのをやめる」の後も、点の欄に残る点(置く線)を見せ続ける。線の決め方を
 * 「点を入れる」に戻すと消える(0)。
 */
interface StrokeView { readonly points: number; readonly segments: number; readonly closed: boolean }

async function strokeView(page: Page): Promise<StrokeView> {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportFrameStroke');
    const value: unknown = typeof read === 'function' ? read() : null;
    if (value === null || typeof value !== 'object') throw new Error('検査専用の口 pcadViewportFrameStroke が見つかりません。');
    const points: unknown = Reflect.get(value, 'points');
    const segments: unknown = Reflect.get(value, 'segments');
    const closed: unknown = Reflect.get(value, 'closed');
    if (typeof points !== 'number' || typeof segments !== 'number' || typeof closed !== 'boolean') {
      throw new Error('pcadViewportFrameStroke の欄の型が違います。');
    }
    return { points, segments, closed };
  });
}

async function expectStrokeView(page: Page, expected: StrokeView): Promise<void> {
  await expect.poll(() => strokeView(page)).toEqual(expected);
}

export function registerFrameStrokeLineTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-08 第 2 段 3D の一時の線', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('点を 3 つ打つと 3 点・線 2 本、閉じると 3 本、打つのをやめても残り、線の決め方を戻すと 0', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const fixturePath = info.outputPath('two-box-stroke-line.pcada');
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
      await expectStrokeView(page, { points: 0, segments: 0, closed: false });

      await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('stroke');
      await clickWorldPointChecked(page, a);
      await clickWorldPointChecked(page, d);
      await clickWorldPointChecked(page, c);
      await expectStrokeView(page, { points: 3, segments: 2, closed: false });
      // 最初の点を押し直すと閉じる(点は増えず、C → A の線が足される)。
      await clickWorldPointChecked(page, a);
      await expectStrokeView(page, { points: 3, segments: 3, closed: true });
      await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.stroke.end'), exact: true }).click();
      await expectStrokeView(page, { points: 3, segments: 3, closed: true });
      await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('points');
      await expectStrokeView(page, { points: 0, segments: 0, closed: false });
      expect(errors).toEqual([]);
    });
  });
}
