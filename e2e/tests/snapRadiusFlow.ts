/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { componentRows, goHome, homeViewPagePoint } from './boltedJointTestSupport.js';
import { frameLayout, topCorners } from './frameStrokeFlow.js';
import { closeInputBindings, inputBindingsWindow, openInputBindings } from './inputBindingsWindowSupport.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * 配置の補助 P-D 吸着の幅: 操作の割り当ての窓のタブ「マウスのボタン」で吸着の幅を「大」にして適用すると、一筆書きで部品の頂点から
 * 画面で 8 画素右を押しても、その頂点に吸い付く(頂点への吸着の半径は 小 3・中 6〔既定〕・大 10 画素。中のままなら 8 画素は外で、
 * 前の点の高さの面〔z = 0〕の上の点になる。単体 snapRadiusSetting.test.ts と frameStrokePick の単体で確かめた値)。
 * 頂点 A は frameStrokeFlow.ts と同じ読み方(辺の一覧の中点)。押す位置はホーム視点の写し方で A の画面の位置を出して 8 画素足す。
 */
export function registerSnapRadiusTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('P-D 吸着の幅', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('吸着の幅を大にすると、一筆書きで頂点から 8 画素離れた所を押しても頂点に吸い付く', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);

      await openInputBindings(page, 'mouse');
      const form = inputBindingsWindow(page).getByRole('form', { name: uiMessage('view', 'settings.snapRadius.title'), exact: true });
      await form.getByRole('combobox', { name: uiMessage('view', 'settings.snapRadius.label'), exact: true }).selectOption('large');
      await form.getByRole('button', { name: uiMessage('view', 'settings.snapRadius.apply'), exact: true }).click();
      await expect(form).toHaveAttribute('data-settings-draft', 'false');
      await closeInputBindings(page);

      const fixturePath = info.outputPath('two-box-snap-radius.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);
      await goHome(page);
      await componentRows(page).nth(0).click();
      const dialog = await openFramePicker(page);
      await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
      const layout = frameLayout(page, dialog);
      await layout.locator('summary').click();
      const { a } = await topCorners(layout);
      await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('stroke');
      const [x, y] = await homeViewPagePoint(page, a);
      await page.mouse.click(x + 8, y);
      await expect(layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true }))
        .toHaveValue(a.map(value => String(value)).join(' '));
      expect(errors).toEqual([]);
    });
  });
}
