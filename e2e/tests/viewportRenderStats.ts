import { expect, type Page } from '@playwright/test';

interface ViewportRenderStats {
  readonly completedRenders: number;
  readonly lastCompletedAtMs: number;
  readonly totalSceneRenderMs: number;
  readonly totalDrawListenerMs: number;
}

declare global {
  interface Window {
    pcadViewportRenderStats?: () => ViewportRenderStats;
    pcadViewportFramedBodies?: () => readonly string[];
  }
}

export async function readViewportRenderStats(page: Page): Promise<ViewportRenderStats> {
  return page.evaluate(() => {
    const read = window.pcadViewportRenderStats;
    if (read === undefined) {
      throw new Error('検査専用の口 pcadViewportRenderStats が見つかりません。');
    }
    return read();
  });
}

/** 対象の形を描いた状態でカメラとhoverを動かし、完了したscene.renderだけからfpsを求める。 */
export async function measureViewportFps(page: Page): Promise<{
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
    cssWidth: element.clientWidth, cssHeight: element.clientHeight,
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
    // client寸法は整数、boundingBoxは小数。操作前後の同じ測定値を厳密に比較する。
    expect(interactiveBuffer.cssWidth).toBe(normalBuffer.cssWidth);
    expect(interactiveBuffer.cssHeight).toBe(normalBuffer.cssHeight);
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
    cssWidth: element.clientWidth, cssHeight: element.clientHeight,
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
  const webgl = await canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext('webgl2');
    if (gl === null) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: String(info === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
      width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
  });
  // 起動引数を変えた結果、手元だけ実GPUへ逃げて合格することを防ぐ。
  expect(webgl?.renderer).toMatch(/SwiftShader/i);
  console.log('[描画診断]', JSON.stringify({
    sceneRenderMs: after.totalSceneRenderMs - before.totalSceneRenderMs,
    drawListenerMs: after.totalDrawListenerMs - before.totalDrawListenerMs,
    moves: moveDurations.length,
    averageMoveMs: moveDurations.reduce((sum, ms) => sum + ms, 0) / moveDurations.length,
    maxMoveMs: Math.max(...moveDurations),
    completedRenders, elapsedMs,
    webgl,
  }));
  return { fps: completedRenders * 1_000 / elapsedMs, completedRenders, elapsedMs };
}
