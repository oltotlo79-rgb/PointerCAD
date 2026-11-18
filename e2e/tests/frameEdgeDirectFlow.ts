/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, test as base, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, goHome } from './boltedJointTestSupport.js';
import { openSaveFlowFile } from './saveResponsivenessFlow.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * B-10 ビューで辺を直接クリックして選ぶ: 2 つの箱(2 つ目は x = 40)の組立で、線の決め方を「辺から」にし、2 つ目の箱だけを読み込む(12 本)。
 * 読み込んでいない 1 つ目の箱の上の面の辺の中点(2 つ目の箱の上の面の辺の中点から x を 40 戻した点。箱は同じ形)を 3D の画面で押すと、
 * 1 つ目の箱のまっすぐな辺 12 本が一覧に足されて 24 本になり、押した辺だけにチェックが入る。もう一度押すと外れる。
 */
type Point = readonly [number, number, number];

function detailsOf(page: Page, dialog: Locator, key: string): Locator {
  return dialog.locator('details').filter({ has: page.locator('summary', { hasText: uiMessagePattern('catalog', key) }) });
}

/** 一覧の行の「中点 (x, y, z)」。 */
async function midpoints(layout: Locator): Promise<readonly Point[]> {
  return (await layout.locator('li').allInnerTexts()).map((text): Point => {
    const match = /\(([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+)\)\s*$/u.exec(text);
    return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  });
}

export function registerFrameEdgeDirectTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('B-10 ビューで辺を直接クリックして選ぶ', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('読み込んでいない箱の辺を 3D の画面で押すと、その箱の辺 12 本が一覧に足されて押した辺にチェックが入り、もう一度押すと外れる',
      async ({ page }, info: TestInfo) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const app = appForPage(page);
        await startAssembly(page, app);
        const fixturePath = info.outputPath('two-box-direct.pcada');
        await writeFile(fixturePath, await twoBoxAssemblyFile(40));
        await openSaveFlowFile(page, fixturePath, app);
        await expect(componentRows(page)).toHaveCount(2);
        await goHome(page);
        await componentRows(page).nth(1).click();

        const dialog = await openFramePicker(page);
        await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
        const layout = detailsOf(page, dialog, 'catalog.frameLayout.title');
        await layout.locator('summary').click();
        await choice(layout, 'catalog', 'catalog.frameLayout.source').selectOption('edges');
        await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.loadEdges'), exact: true }).click();
        const edges = layout.getByRole('checkbox');
        await expect(edges).toHaveCount(12);
        const second = await midpoints(layout);
        const top = Math.max(...second.map((point) => point[2]));
        const target = second.find((point) => point[2] === top);
        if (target === undefined) throw new Error('上の面の辺がありません。');
        // 1 つ目の箱(x = 0)の同じ辺の中点。
        const first: Point = [target[0] - 40, target[1], target[2]];
        await clickWorldPointChecked(page, first);
        await expect(edges).toHaveCount(24);
        await expect(layout.getByRole('checkbox', { checked: true })).toHaveCount(1);
        // チェックが入ったのは、押した辺(中点が first の行)。一覧は辺の番号の順なので、2 つの箱の行は混ざって並ぶ。
        const index = (await midpoints(layout)).findIndex((point) => point.every((value, axis) => Math.abs(value - (first[axis] ?? 0)) < 1e-6));
        expect(index).not.toBe(-1);
        await expect(edges.nth(index)).toBeChecked();
        await clickWorldPointChecked(page, first);
        await expect(layout.getByRole('checkbox', { checked: true })).toHaveCount(0);
        expect(errors).toEqual([]);
      });
  });
}
