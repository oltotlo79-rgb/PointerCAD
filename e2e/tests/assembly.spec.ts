/// <reference lib="dom" />
import { statSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  boxPartFile,
  chooseToolMenuItem,
  distinctFiftyPartAssemblyFile,
  installAssemblyFileGateway,
  readAssemblyStats,
  replacementAssemblyFile,
  resetAssemblyFileGateway,
  spherePartFile,
  twoBoxAssemblyFile,
} from './assemblyTestSupport.js';
import { beginRecompute, readRecomputeStats, waitForRecompute, type RecomputeToken } from './recompute.js';

interface ViewportRenderStats {
  readonly completedRenders: number;
  readonly lastCompletedAtMs: number;
  readonly totalSceneRenderMs: number;
  readonly totalDrawListenerMs: number;
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
  return treeSectionRows(page, '部品').locator('.pcad-tree__select');
}

function componentMoreButtons(page: Page): Locator {
  return treeSectionRows(page, '部品').locator('.pcad-tree__more');
}

function treeSectionRows(page: Page, sectionName: string): Locator {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: sectionName }),
  });
  return section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
}

async function chooseFileMenu(page: Page, name: string): Promise<void> {
  await chooseToolMenuItem(page, 'ファイルのほかの操作', name);
}

async function chooseComponentAction(page: Page, name: string): Promise<void> {
  await chooseToolMenuItem(page, '組む', name);
}

async function chooseMateAction(page: Page, name: string): Promise<void> {
  await chooseToolMenuItem(page, '合わせる', name);
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

async function placeQueuedPart(page: Page, sources: readonly string[]): Promise<void> {
  await chooseToolMenuItem(page, '組む', '部品を置く');
  const dialog = page.getByRole('dialog', { name: '部品を置く位置' });
  await expect(dialog).toBeVisible();
  const fields = dialog.locator('input.pcad-field__input');
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] !== '') await fields.nth(index).fill(sources[index]);
  }
  const token = await beginRecompute(page);
  await fields.first().press('Enter');
  await expect(dialog).toHaveCount(0);
  await waitForRecompute(page, token);
}

async function createOriginMate(
  page: Page,
  kind: '一致' | '距離',
  element: '選択部品の原点' | 'Z軸',
  source?: string,
  expectedOutcome: 'success' | 'failed' = 'success',
): Promise<void> {
  await chooseMateAction(page, kind);
  const dialog = page.getByRole('dialog', { name: '合致を作る' });
  await expect(dialog).toBeVisible();
  for (const index of [0, 1]) {
    await selectComponent(page, index);
    const originButton = dialog.getByRole('button', { name: element, exact: true });
    const layer = await originButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const panel = button.closest<HTMLElement>('[role="dialog"]');
      const canvas = document.querySelector<HTMLElement>('.pcad-viewport__canvas');
      return {
        hit: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : String(hit),
        hitInsidePanel: panel !== null && hit !== null && panel.contains(hit),
        panelZ: panel === null ? null : getComputedStyle(panel).zIndex,
        panelPointerEvents: panel === null ? null : getComputedStyle(panel).pointerEvents,
        canvasZ: canvas === null ? null : getComputedStyle(canvas).zIndex,
        buttonRect: [rect.left, rect.top, rect.width, rect.height],
        panelRect: panel === null ? null : (() => {
          const value = panel.getBoundingClientRect();
          return [value.left, value.top, value.width, value.height];
        })(),
      };
    });
    expect(layer.hitInsidePanel, JSON.stringify(layer)).toBe(true);
    await originButton.click();
  }
  if (source !== undefined) await dialog.locator('input.pcad-field__input').fill(source);
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '合致を作る', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  if (expectedOutcome === 'success') await waitForRecompute(page, token);
  else await waitForRecomputeCompletion(page, token, 'failed');
}

async function waitForRecomputeCompletion(
  page: Page,
  token: RecomputeToken,
  outcome: 'success' | 'failed',
): Promise<void> {
  await expect.poll(async () => {
    const stats = await readRecomputeStats(page);
    return stats.completedGeneration > token.requestedGeneration
      && stats.completedGeneration === stats.requestedGeneration && !stats.isComputing
      ? stats.lastOutcome : 'idle';
  }).toBe(outcome);
}

async function openAssemblyFixture(
  page: Page,
  bytes: Uint8Array,
  expectedOutcome: 'success' | 'failed' = 'success',
): Promise<void> {
  await installAssemblyFileGateway(page, { documents: [{ name: 'fixture.pcada', bytes }] });
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (expectedOutcome === 'success') await waitForRecompute(page, token);
  else await waitForRecomputeCompletion(page, token, 'failed');
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
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
async function measureViewportFps(page: Page): Promise<{
  readonly fps: number;
  readonly completedRenders: number;
  readonly elapsedMs: number;
}> {
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('ビューポートのcanvasの位置を取得できません。');
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const normalBuffer = await canvas.evaluate((element: HTMLCanvasElement) => ({
    width: element.width, height: element.height,
  }));
  await page.mouse.move(centerX, centerY);
  const before = await readViewportRenderStats(page);
  const startedAtMs = await page.evaluate(() => performance.now());
  const moveDurations: number[] = [];

  await page.mouse.down({ button: 'middle' });
  try {
    const interactiveBuffer = await canvas.evaluate((element: HTMLCanvasElement) => ({
      width: element.width, height: element.height,
      cssWidth: element.clientWidth, cssHeight: element.clientHeight,
    }));
    expect(interactiveBuffer.width).toBeLessThan(normalBuffer.width);
    expect(interactiveBuffer.height).toBeLessThan(normalBuffer.height);
    expect(interactiveBuffer.cssWidth).toBeCloseTo(box.width, 0);
    expect(interactiveBuffer.cssHeight).toBeCloseTo(box.height, 0);
    // mouse.move自体がCDPの入力処理完了を待つ。ここへsleepを足すと次の入力が
    // フレーム締切を逃し、描画能力ではなくテストの入力待ちをfpsとして測ってしまう。
    // 実マウス入力を逐次送り、要求を1描画機会へまとめる本番経路を約2秒動かす。
    const measurementEndsAt = Date.now() + 2_000;
    let frame = 0;
    while (Date.now() < measurementEndsAt) {
      const direction = frame % 2 === 0 ? 1 : -1;
      const moveStartedAt = performance.now();
      await page.mouse.move(centerX + direction * 36, centerY + direction * 18);
      moveDurations.push(performance.now() - moveStartedAt);
      frame += 1;
    }
  } finally {
    await page.mouse.up({ button: 'middle' });
  }
  expect(await canvas.evaluate((element: HTMLCanvasElement) => ({
    width: element.width, height: element.height,
  }))).toEqual(normalBuffer);
  // カメラ操作後はボタンを離して別の位置へ動かし、通常のhover更新も実描画へ通す。
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.waitForTimeout(16);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await page.waitForTimeout(32);

  const endedAtMs = await page.evaluate(() => performance.now());
  const after = await readViewportRenderStats(page);
  expect(after.completedRenders).toBeGreaterThan(before.completedRenders);
  expect(after.lastCompletedAtMs).toBeGreaterThanOrEqual(startedAtMs);
  const completedRenders = after.completedRenders - before.completedRenders;
  const elapsedMs = endedAtMs - startedAtMs;
  console.log('[描画診断]', JSON.stringify({
    sceneRenderMs: after.totalSceneRenderMs - before.totalSceneRenderMs,
    drawListenerMs: after.totalDrawListenerMs - before.totalDrawListenerMs,
    moves: moveDurations.length,
    averageMoveMs: moveDurations.reduce((sum, ms) => sum + ms, 0) / moveDurations.length,
    maxMoveMs: Math.max(...moveDurations),
    completedRenders, elapsedMs,
    webgl: await canvas.evaluate((element: HTMLCanvasElement) => {
      const gl = element.getContext('webgl2');
      if (gl === null) return null;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL),
        width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
    }),
  }));
  return { fps: completedRenders * 1_000 / elapsedMs, completedRenders, elapsedMs };
}

test.describe('P7 アセンブリの配置と基本操作', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('空状態、原点・式配置、各Undo、保存往復、見分けられる同じ箱50個', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await disableFilePickers(page);
    const box = boxPartFile();
    const distinctAssembly = await distinctFiftyPartAssemblyFile();

    await page.goto('/');
    // 手組みのpcadaを使わず、製品のファイルメニューから空のアセンブリを始める。
    const newAssemblyToken = await beginRecompute(page);
    await chooseFileMenu(page, '新しいアセンブリ');
    await waitForRecompute(page, newAssemblyToken);
    await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('部品を置いて');
    await expect(componentRows(page)).toHaveCount(0);

    // 計画書どおり検査内で作った部品をfileGatewayへ並べ、製品の「部品を置く」を50回通す。
    await installAssemblyFileGateway(page, {
      parts: Array.from({ length: 50 }, () => ({ fileName: '箱.pcad', bytes: box })),
    });

    await placeQueuedPart(page, ['', '', '']);
    await expect(componentRows(page)).toHaveCount(1);
    await undoAndWait(page);
    await expect(componentRows(page)).toHaveCount(0);
    await redoAndWait(page);
    await expect(componentRows(page)).toHaveCount(1);

    await placeQueuedPart(page, ['10*2', '', '']);
    await expect(componentRows(page)).toHaveCount(2);
    await selectComponent(page, 1);

    let token = await beginRecompute(page);
    await chooseComponentAction(page, '固定する');
    await waitForRecompute(page, token);
    await expect(page.locator('.pcad-tree__badge', { hasText: '固定' })).toHaveCount(2);
    await undoAndWait(page);
    await expect(page.locator('.pcad-tree__badge', { hasText: '固定' })).toHaveCount(1);
    await redoAndWait(page);
    await expect(page.locator('.pcad-tree__badge', { hasText: '固定' })).toHaveCount(2);

    // Undo/Redoは選択を消すため、次の操作前に毎回対象を明示的に選び直す。
    await selectComponent(page, 1);
    token = await beginRecompute(page);
    await chooseTreeComponentAction(page, 1, '画面から隠す');
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
      await placeQueuedPart(page, [String(x), String(y), '']);
    }
    await expect(componentRows(page)).toHaveCount(50);
    const fps = await measureViewportFps(page);
    console.log(`[実測] アセンブリ50個のビューポート: ${fps.fps.toFixed(1)} fps (${fps.completedRenders}描画/${fps.elapsedMs.toFixed(1)}ms、60推奨)`);
    expect(fps.fps).toBeGreaterThanOrEqual(30);
    const beforeHome = await readViewportRenderStats(page);
    await page.getByRole('button', { name: 'ホーム視点', exact: true }).click();
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(beforeHome.completedRenders);
    await testInfo.attach('assembly-50-distinct-boxes', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    // ここから先は保存・OSファイル選択の実経路へ戻す。
    await resetAssemblyFileGateway(page);
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
    await installAssemblyFileGateway(page, {
      documents: [{ name: '異なる10種50個.pcada', bytes: distinctAssembly }],
    });
    const beforeDistinctRender = await readViewportRenderStats(page);
    const distinctStartedAt = await page.evaluate(() => performance.now());
    const distinctToken = await beginRecompute(page);
    await fileAction(page, '開く').click();
    await waitForRecompute(page, distinctToken);
    await expect(componentRows(page)).toHaveCount(50);
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(beforeDistinctRender.completedRenders);
    const distinctElapsed = await page.evaluate((startedAt) => performance.now() - startedAt, distinctStartedAt);
    console.log(`[実測] 異なる部品10種・合計50個を開いて描画: ${distinctElapsed.toFixed(1)} ms (上限5000ms)`);
    expect(distinctElapsed).toBeLessThanOrEqual(5_000);
    expect(new Set((await readAssemblyStats(page)).components.map((component) => component.sourceRef)).size).toBe(10);
    expect(errors).toEqual([]);
  });

  test('(a) 部品2つを置いて合致し、干渉の赤表示・分解図・部品表まで通せる', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await disableFilePickers(page);
    await page.goto('/');
    const token = await beginRecompute(page);
    await chooseFileMenu(page, '新しいアセンブリ');
    await waitForRecompute(page, token);
    const box = boxPartFile();
    await installAssemblyFileGateway(page, { parts: [
      { fileName: '箱.pcad', bytes: box }, { fileName: '箱.pcad', bytes: box },
    ] });
    await placeQueuedPart(page, ['', '', '']);
    await placeQueuedPart(page, ['40', '', '']);
    await expect(componentRows(page)).toHaveCount(2);
    await createOriginMate(page, '一致', '選択部品の原点');

    const beforeInterferenceRender = await readViewportRenderStats(page);
    await page.getByRole('group', { name: '組む' })
      .getByRole('button', { name: '干渉を調べる', exact: true }).click();
    const interferenceRow = page.locator('.pcad-interference__row').first();
    await expect(interferenceRow).toBeVisible();
    await interferenceRow.click();
    await expect(interferenceRow).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await readAssemblyStats(page)).interferenceSelectedKey).not.toBeNull();
    await expect.poll(async () => (await readViewportRenderStats(page)).completedRenders)
      .toBeGreaterThan(beforeInterferenceRender.completedRenders);

    await selectComponent(page, 1);
    await page.getByRole('group', { name: '組む' })
      .getByRole('button', { name: '分解図', exact: true }).click();
    const explode = page.getByRole('dialog', { name: '分解ステップを作る' });
    await expect(explode).toBeVisible();
    const explodeToken = await beginRecompute(page);
    await explode.locator('input.pcad-field__input').press('Enter');
    await waitForRecompute(page, explodeToken);
    await expect(treeSectionRows(page, '分解ステップ')).toHaveCount(1);

    await page.getByRole('group', { name: '組む' })
      .getByRole('button', { name: '部品表', exact: true }).click();
    const bomRow = page.locator('.pcad-bom__table tbody tr');
    await expect(bomRow).toHaveCount(1);
    await expect(bomRow.locator('td').nth(2)).toHaveText('2');
    expect(errors).toEqual([]);
  });

  test('(b) 固定した部品は動かず、もう1つだけが距離合致で動く', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await disableFilePickers(page);
    const fixture = await twoBoxAssemblyFile(50);
    await page.goto('/');
    await openAssemblyFixture(page, fixture);
    const before = await readAssemblyStats(page);
    await createOriginMate(page, '距離', '選択部品の原点', '10');
    const after = await readAssemblyStats(page);
    expect(before.components[0]?.fixed).toBe(true);
    expect(before.components[1]?.fixed).toBe(false);
    expect(after.components[0]?.resolved).toEqual(before.components[0]?.resolved);
    expect(after.components[1]?.resolved).not.toEqual(before.components[1]?.resolved);
    const fixed = after.components[0]?.resolved?.position;
    const moved = after.components[1]?.resolved?.position;
    if (fixed === undefined || moved === undefined) throw new Error('合致後の配置を取得できません。');
    expect(Math.hypot(moved[0] - fixed[0], moved[1] - fixed[1], moved[2] - fixed[2])).toBeCloseTo(10, 5);
    expect(errors).toEqual([]);
  });

  test('(c) 矛盾する合致を足すと原因の合致が木とプロパティで指される', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await disableFilePickers(page);
    const fixture = await twoBoxAssemblyFile(40);
    await page.goto('/');
    await openAssemblyFixture(page, fixture);
    await createOriginMate(page, '一致', '選択部品の原点');
    await createOriginMate(page, '距離', '選択部品の原点', '10', 'failed');
    const diagnosis = (await readAssemblyStats(page)).diagnosis;
    expect(diagnosis?.converged).toBe(false);
    expect(diagnosis?.provenConflictMateIds).toEqual([]);
    expect(diagnosis?.suspectedConflictMateIds).toContain('mate-2');
    const secondMate = treeSectionRows(page, '合致').nth(1);
    await expect(secondMate.locator('.pcad-tree__badge')).toContainText('両立を確認できません');
    await secondMate.locator('.pcad-tree__select').click();
    await expect(page.locator('.pcad-property-list')).toContainText('両立を確認できません');
    expect(errors).toEqual([]);
  });

  test('(f) 部品を差し替える前に不一致を予告し、確定後も合致2本を保つ', async ({ page }) => {
    const errors = collectBrowserErrors(page);
    await disableFilePickers(page);
    const fixture = await replacementAssemblyFile();
    const replacement = spherePartFile('差し替え球');
    await page.goto('/');
    await openAssemblyFixture(page, fixture, 'failed');
    const before = await readAssemblyStats(page);
    await installAssemblyFileGateway(page, { parts: [{ fileName: '差し替え球.pcad', bytes: replacement }] });
    await selectComponent(page, 0);
    await chooseComponentAction(page, '置換する');
    const preview = page.getByRole('dialog', { name: '置換する' });
    await expect(preview).toContainText('合致 2 本のうち 1 本');
    const token = await beginRecompute(page);
    await preview.getByRole('button', { name: '差し替える', exact: true }).click();
    await waitForRecomputeCompletion(page, token, 'failed');
    const after = await readAssemblyStats(page);
    expect(after.mateIds).toEqual(['mate-1', 'mate-2']);
    expect(after.components[0]?.sourceRef).not.toBe(before.components[0]?.sourceRef);
    await expect(treeSectionRows(page, '合致')).toHaveCount(2);
    const validMate = treeSectionRows(page, '合致').first();
    await validMate.locator('.pcad-tree__select').click();
    await expect(page.locator('.pcad-property-list')).toContainText('解決済み');
    expect(errors).toEqual([]);
  });
});
