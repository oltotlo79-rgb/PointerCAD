/// <reference lib="dom" />
import { statSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { beginRecompute, waitForRecompute } from './recompute.js';

interface ViewportRenderStats {
  readonly completedRenders: number;
  readonly lastCompletedAtMs: number;
}

declare global {
  interface Window {
    pcadViewportRenderStats?: () => ViewportRenderStats;
  }
}

async function disableFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
    }
  });
}

function fileAction(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name, exact: true });
}

function componentRows(page: Page): Locator {
  return page.locator('.pcad-tree__children .pcad-tree__select');
}

function componentMoreButtons(page: Page): Locator {
  return page.locator('.pcad-tree__children .pcad-tree__more');
}

function toolMenuPanel(page: Page, menu: string): Locator {
  return page.locator('.pcad-toolbar').getByRole('group', { name: menu, exact: true });
}

async function openToolMenu(page: Page, menu: string): Promise<void> {
  if ((await toolMenuPanel(page, menu).count()) === 0) {
    await page.locator('.pcad-toolbar').getByRole('button', { name: new RegExp(`^${menu}`, 'u') }).first().click();
  }
  await expect(toolMenuPanel(page, menu)).toBeVisible();
}

async function chooseFileMenu(page: Page, name: string): Promise<void> {
  await openToolMenu(page, 'ファイルのほかの操作');
  await toolMenuPanel(page, 'ファイルのほかの操作')
    .getByRole('button', { name, exact: true })
    .click();
}

async function chooseComponentAction(page: Page, name: string): Promise<void> {
  await openToolMenu(page, '部品の操作');
  await toolMenuPanel(page, '部品の操作').getByRole('button', { name, exact: true }).click();
}

async function chooseTreeComponentAction(page: Page, index: number, name: string): Promise<void> {
  await componentMoreButtons(page).nth(index).click();
  const item = page.locator('.pcad-tree__menu').getByRole('menuitem', { name, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

async function selectComponent(page: Page, index: number): Promise<void> {
  const row = componentRows(page).nth(index);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

async function placePart(page: Page, partPath: string, sources: readonly string[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('group', { name: '組む' }).getByRole('button', { name: '部品を置く' }).click();
  await (await chooser).setFiles(partPath);
  await expect(page.getByRole('dialog', { name: '部品を置く位置' })).toBeVisible();
  const fields = page.locator('.pcad-popover input.pcad-field__input');
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] !== '') await fields.nth(index).fill(sources[index]);
  }
  const token = await beginRecompute(page);
  await fields.first().press('Enter');
  await expect(page.getByRole('dialog', { name: '部品を置く位置' })).toHaveCount(0);
  await waitForRecompute(page, token);
}

async function undoAndWait(page: Page): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-tree__select[aria-pressed="true"]')).toHaveCount(0);
}

async function redoAndWait(page: Page): Promise<void> {
  const token = await beginRecompute(page);
  await page.getByRole('button', { name: 'やり直す', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-tree__select[aria-pressed="true"]')).toHaveCount(0);
}

async function readViewportRenderStats(page: Page): Promise<ViewportRenderStats> {
  return page.evaluate(() => {
    const read = window.pcadViewportRenderStats;
    if (read === undefined) {
      throw new Error('検査専用の口 pcadViewportRenderStats が見つかりません。');
    }
    return read();
  });
}

/** 50個を描いた状態でカメラとhoverを動かし、完了したscene.renderだけからfpsを求める。 */
async function measureViewportFps(page: Page): Promise<number> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('ビューポートのcanvasの位置を取得できません。');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  const before = await readViewportRenderStats(page);
  const startedAtMs = await page.evaluate(() => performance.now());

  await page.mouse.down({ button: 'middle' });
  try {
    // 描画より細かい間隔で視点を往復させ、要求を1描画機会へまとめる本番経路を約2秒動かす。
    const measurementEndsAt = Date.now() + 2_000;
    let frame = 0;
    while (Date.now() < measurementEndsAt) {
      const direction = frame % 2 === 0 ? 1 : -1;
      await page.mouse.move(centerX + direction * 36, centerY + direction * 18);
      await page.waitForTimeout(8);
      frame += 1;
    }
  } finally {
    await page.mouse.up({ button: 'middle' });
  }
  // カメラ操作後はボタンを離して別の位置へ動かし、通常のhover更新も実描画へ通す。
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.waitForTimeout(16);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await page.waitForTimeout(32);

  const endedAtMs = await page.evaluate(() => performance.now());
  const after = await readViewportRenderStats(page);
  expect(after.completedRenders).toBeGreaterThan(before.completedRenders);
  expect(after.lastCompletedAtMs).toBeGreaterThanOrEqual(startedAtMs);
  return (after.completedRenders - before.completedRenders) * 1_000 / (endedAtMs - startedAtMs);
}

test.describe('P7 アセンブリの配置と基本操作', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('空状態、原点・式配置、各Undo、保存往復、見分けられる同じ箱50個', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await disableFilePickers(page);
    const boxPath = testInfo.outputPath('box.pcad');

    await page.goto('/');
    // 実際の画面で箱を作って保存し、配置元ファイルにする。
    await openToolMenu(page, '作る');
    await toolMenuPanel(page, '作る').getByRole('button', { name: '箱', exact: true }).click();
    const boxToken = await beginRecompute(page);
    await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
    await waitForRecompute(page, boxToken);
    const boxDownload = page.waitForEvent('download');
    await fileAction(page, '保存').click();
    await (await boxDownload).saveAs(boxPath);
    expect(statSync(boxPath).size).toBeGreaterThan(0);

    // 手組みのpcadaを使わず、製品のファイルメニューから空のアセンブリを始める。
    const newAssemblyToken = await beginRecompute(page);
    await chooseFileMenu(page, '新しいアセンブリ');
    await waitForRecompute(page, newAssemblyToken);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('部品を置いて');
    await expect(componentRows(page)).toHaveCount(0);

    await placePart(page, boxPath, ['', '', '']);
    await expect(componentRows(page)).toHaveCount(1);
    await undoAndWait(page);
    await expect(componentRows(page)).toHaveCount(0);
    await redoAndWait(page);
    await expect(componentRows(page)).toHaveCount(1);

    await placePart(page, boxPath, ['10*2', '', '']);
    await expect(componentRows(page)).toHaveCount(2);
    await selectComponent(page, 1);

    let token = await beginRecompute(page);
    await chooseComponentAction(page, '固定を切り替える');
    await waitForRecompute(page, token);
    await expect(page.locator('.pcad-tree__badge', { hasText: '固定' })).toHaveCount(2);
    await undoAndWait(page);
    await expect(page.locator('.pcad-tree__badge', { hasText: '固定' })).toHaveCount(1);
    await redoAndWait(page);
    await expect(page.locator('.pcad-tree__badge', { hasText: '固定' })).toHaveCount(2);

    // Undo/Redoは選択を消すため、次の操作前に毎回対象を明示的に選び直す。
    await selectComponent(page, 1);
    token = await beginRecompute(page);
    await chooseComponentAction(page, '表示を切り替える');
    await waitForRecompute(page, token);
    await expect(page.locator('.pcad-tree__badge', { hasText: '非表示' })).toHaveCount(1);
    await undoAndWait(page);
    await expect(page.locator('.pcad-tree__badge', { hasText: '非表示' })).toHaveCount(0);
    await redoAndWait(page);
    await expect(page.locator('.pcad-tree__badge', { hasText: '非表示' })).toHaveCount(1);

    // 複製・削除は行へ平置きされず、対象行の「⋮」メニューからだけ実行できる。
    await expect(page.locator('.pcad-tree__row--child').getByRole('button', { name: '複製する' })).toHaveCount(0);
    await expect(page.locator('.pcad-tree__row--child').getByRole('button', { name: '削除する' })).toHaveCount(0);
    await selectComponent(page, 1);
    token = await beginRecompute(page);
    await chooseTreeComponentAction(page, 1, '複製する');
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(3);
    await undoAndWait(page);
    await expect(componentRows(page)).toHaveCount(2);
    await redoAndWait(page);
    await expect(componentRows(page)).toHaveCount(3);

    await selectComponent(page, 1);
    const removedName = await componentRows(page).nth(1).locator('.pcad-tree__label').innerText();
    token = await beginRecompute(page);
    await chooseTreeComponentAction(page, 1, '削除する');
    await waitForRecompute(page, token);
    await expect(componentRows(page)).toHaveCount(2);
    await expect(page.locator('.pcad-tree__children').getByText(removedName, { exact: true })).toHaveCount(0);
    await expect(page.locator('.pcad-tree__select[aria-pressed="true"]')).toHaveCount(0);
    await undoAndWait(page);
    await expect(componentRows(page)).toHaveCount(3);
    await expect(page.locator('.pcad-tree__children').getByText(removedName, { exact: true })).toHaveCount(1);
    await redoAndWait(page);
    await expect(componentRows(page)).toHaveCount(2);
    await expect(page.locator('.pcad-tree__children').getByText(removedName, { exact: true })).toHaveCount(0);

    /*
     * 24mm格子から初期2箱(中心0と20)へ24mm未満になる点を除き、先頭48点を使う。
     * 追加箱どうしは4mm以上離れ、初期箱と追加箱も重ならない。初期2箱だけは
     * 原点と20mm式配置なので面が接するが、式検査を保ったまま撮影範囲を小さくできる。
     */
    const gridPositions: [number, number][] = [];
    for (const y of [-72, -48, -24, 0, 24, 48, 72]) {
      for (const x of [-84, -60, -36, -12, 12, 36, 60, 84]) {
        const distanceFromOrigin = Math.hypot(x, y);
        const distanceFromExpressionBox = Math.hypot(x - 20, y);
        if (distanceFromOrigin >= 24 && distanceFromExpressionBox >= 24) {
          gridPositions.push([x, y]);
        }
      }
    }
    const additionalPositions = gridPositions.slice(0, 48);
    expect(additionalPositions).toHaveLength(48);
    for (const [x, y] of additionalPositions) {
      await placePart(page, boxPath, [String(x), String(y), '']);
    }
    await expect(componentRows(page)).toHaveCount(50);
    const fps = await measureViewportFps(page);
    console.log(`[実測] アセンブリ50個のビューポート: ${fps.toFixed(1)} fps (60推奨)`);
    expect(fps).toBeGreaterThanOrEqual(30);
    const beforeHome = await readViewportRenderStats(page);
    await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(beforeHome.completedRenders);
    await testInfo.attach('assembly-50-distinct-boxes', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    const downloadPromise = page.waitForEvent('download');
    await fileAction(page, '保存').click();
    const savedPath = testInfo.outputPath('assembly.pcada');
    await (await downloadPromise).saveAs(savedPath);
    expect(statSync(savedPath).size).toBeGreaterThan(0);

    const reopenChooser = page.waitForEvent('filechooser');
    await fileAction(page, '開く').click();
    const reopenToken = await beginRecompute(page);
    await (await reopenChooser).setFiles(savedPath);
    await waitForRecompute(page, reopenToken);
    await expect(componentRows(page)).toHaveCount(50);
    expect(errors).toEqual([]);
  });
});
