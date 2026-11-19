/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { choice, startAssembly } from './aluminumFrameCatalogFlow.js';
import { treeSectionRows } from './assemblyCaptureSupport.js';
import { chooseToolMenuItem, readAssemblyStats, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome, homeViewPagePoint } from './boltedJointTestSupport.js';
import type { WorldPoint } from './homeViewProjection.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage } from './uiMessages.js';

/*
 * 配置の補助 P-A の残り「3D の画面で基準の部品を押して選ぶ」: 箱 2 つ(1 辺 20 mm で原点が中心、配置の X が 0 と 40)の組立で 2 つ目を選び、
 * 寸法で動かすの「3D で選ぶ」を押してから 3D の画面で部品を押す。
 * - 動かす部品(2 つ目)を押すと、候補でないので断りの案内が出て、基準は原点の面のまま、釦は押したまま。
 * - 1 つ目を押すと基準が 1 つ目(基準の一覧の 2 行目)になり、今の寸法が 20(すき間 40 − 20)、釦が戻る。
 * - その間、部品の選択は 2 つ目のままで、2 つ目の配置は変わらない(選択・ドラッグへ渡していない)。
 * 押す点は各箱の上面の中心(z = 10)。ホーム視点で写し(homeViewPagePoint)、押す前に、その画素の一番上が canvas である事と、
 * 木の行が「指している」(pcad-tree__row--hovered)になる事を確かめる(押し違いを「選べなかった」と取り違えない)。
 * 窓の開け方とファイルの開き方は dimensionMoveFlow.ts と同じ。
 * P-A の残り (2b) 斜めの向きを 3D の面から取る: 向きを「斜め(成分で)」にして成分を (1, 1, 0) にし(すき間 0)、「3D の面・辺から」を押して
 * 1 つ目の右の面(法線 +X)を押すと、成分が (1, 0, 0) に替わり、今の寸法が X と同じ 20 になる(手で解いた値)。面は選ぶ種類の既定(部品)のまま
 * 拾う(部品の選択の種類では面を拾う)。押す前に、その画素の一番上が canvas である事を確かめる(clickWorldPointChecked)。
 */
const dialogOf = (page: Page): Locator =>
  page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.dimensionMove.title'), exact: true });
const current = (value: number): string => uiMessage('assembly', 'assembly.dimensionMove.current').replace('{value}', String(value));
const FIRST_TOP: WorldPoint = [0, 0, 10];
const SECOND_TOP: WorldPoint = [40, 0, 10];
/** 1 つ目の箱の右の面(x = 10、法線 +X)の中心。 */
const FIRST_RIGHT_FACE: WorldPoint = [10, 0, 0];

/** 部品の木の index 番目の行の部品を、3D の画面のワールドの点で押す。 */
async function pressComponent(page: Page, index: number, world: WorldPoint): Promise<void> {
  const [x, y] = await homeViewPagePoint(page, world);
  const top = await page.evaluate(([px, py]) => {
    const element = document.elementFromPoint(px, py);
    return element instanceof HTMLCanvasElement && element.classList.contains('pcad-viewport__canvas')
      ? 'canvas' : element === null ? 'none' : `${element.tagName}.${element.className}`;
  }, [x, y] as const);
  expect(top, `(${world.join(', ')}) を押す位置 (${x.toFixed(0)}, ${y.toFixed(0)}) が覆われています`).toBe('canvas');
  await page.mouse.move(x, y);
  await expect(treeSectionRows(page, '部品').nth(index)).toHaveClass(/pcad-tree__row--hovered/u);
  await page.mouse.click(x, y);
}

export function registerDimensionMovePickTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('P-A 寸法で動かすの基準を 3D の画面で選ぶ', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('動かす部品は断り、別の部品を押すと基準になって今の寸法が出る。選択と配置は変わらない', async ({ page }, info: TestInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const app = appForPage(page);
      await startAssembly(page, app);
      const fixturePath = info.outputPath('two-box-dimension-move-pick.pcada');
      await writeFile(fixturePath, await twoBoxAssemblyFile(40));
      await openSaveFlowFile(page, fixturePath, app);
      await expect(componentRows(page)).toHaveCount(2);
      await goHome(page);

      await componentRows(page).nth(1).click();
      await expect(componentRows(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
      const before = (await readAssemblyStats(page)).components[1]?.resolved;
      await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.dimensionMove'));
      const dialog = dialogOf(page);
      await expect(dialog).toBeVisible();
      const reference = choice(dialog, 'assembly', 'assembly.dimensionMove.reference');
      await expect(reference).toHaveJSProperty('selectedIndex', 0);
      const pick = dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.pick'), exact: true });
      await pick.click();
      await expect(pick).toHaveAttribute('aria-pressed', 'true');
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.dimensionMove.pickHint'), { exact: true })).toBeVisible();

      await pressComponent(page, 1, SECOND_TOP);
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.dimensionMove.pickRefused'), { exact: true })).toBeVisible();
      await expect(reference).toHaveJSProperty('selectedIndex', 0);
      await expect(pick).toHaveAttribute('aria-pressed', 'true');

      await pressComponent(page, 0, FIRST_TOP);
      await expect(reference).toHaveJSProperty('selectedIndex', 1);
      await expect(dialog.getByRole('status')).toHaveText(current(20));
      await expect(pick).toHaveAttribute('aria-pressed', 'false');
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.dimensionMove.hint'), { exact: true })).toBeVisible();

      await expect(componentRows(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
      await expect(componentRows(page).nth(0)).toHaveAttribute('aria-pressed', 'false');
      expect((await readAssemblyStats(page)).components[1]?.resolved).toEqual(before);
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.cancel'), exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('斜めの向きを 3D の面から取る: 1 つ目の右の面(法線 +X)を押すと成分が (1, 0, 0) になり、今の寸法が X と同じ 20 になる',
      async ({ page }, info: TestInfo) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const app = appForPage(page);
        await startAssembly(page, app);
        const fixturePath = info.outputPath('two-box-dimension-move-direction-pick.pcada');
        await writeFile(fixturePath, await twoBoxAssemblyFile(40));
        await openSaveFlowFile(page, fixturePath, app);
        await expect(componentRows(page)).toHaveCount(2);
        await goHome(page);

        await componentRows(page).nth(1).click();
        await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.dimensionMove'));
        const dialog = dialogOf(page);
        await expect(dialog).toBeVisible();
        await choice(dialog, 'assembly', 'assembly.dimensionMove.reference').selectOption({ index: 1 });
        await choice(dialog, 'assembly', 'assembly.dimensionMove.axis')
          .selectOption({ label: uiMessage('assembly', 'assembly.dimensionMove.axis.vector') });
        // 先に成分を (1, 1, 0) にしておき(45° の向きのすき間は 0)、面から取った向きで替わる事を見分ける。
        const component = (key: string): Locator => dialog.getByRole('textbox', { name: uiMessage('assembly', key), exact: true });
        await component('assembly.dimensionMove.vector.y').fill('1');
        await expect(dialog.getByRole('status')).toHaveText(current(0));
        const pickDirection = dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.pickDirection'), exact: true });
        await pickDirection.click();
        await expect(pickDirection).toHaveAttribute('aria-pressed', 'true');
        await expect(dialog.getByText(uiMessage('assembly', 'assembly.dimensionMove.pickDirectionHint'), { exact: true })).toBeVisible();

        // 1 つ目の箱の右の面(x = 10)の中心。ホーム視点のカメラは +X 側にあり、この面は見えている(2 つ目の箱に隠れない)。
        await clickWorldPointChecked(page, FIRST_RIGHT_FACE);
        await expect(pickDirection).toHaveAttribute('aria-pressed', 'false');
        // 法線の向き(+ か -)は面の向きのとおり。寸法は向きの + - に依らない(部品が基準のどちら側かを中心で決めるので、どちらでも 20)。
        await expect(component('assembly.dimensionMove.vector.x')).toHaveValue(/^-?1$/u);
        await expect(component('assembly.dimensionMove.vector.y')).toHaveValue('0');
        await expect(component('assembly.dimensionMove.vector.z')).toHaveValue('0');
        await expect(dialog.getByRole('status')).toHaveText(current(20));
        await expect(componentRows(page).nth(1)).toHaveAttribute('aria-pressed', 'true');
        await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.dimensionMove.cancel'), exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(errors).toEqual([]);
      });
  });
}
