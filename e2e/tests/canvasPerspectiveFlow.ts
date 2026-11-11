/// <reference lib="dom" />
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { addImage, canvasRow, open, readPart, save } from './canvasAssetLifetimeFlow.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { waitForSettledRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { clickWorldPoint } from './workPlaneCaptureSupport.js';

type Point = readonly [number, number];
type Matrix = readonly [number, number, number, number, number, number, number, number, number];
const WIDTH = 1000;
const HEIGHT = 800;
const MAX_CENTER_ERROR_CSS_PX = 1;
const MARKER_SEARCH_RADIUS_CSS_PX = 12;
const INTERNAL = [0.25, 0.5, 0.75] as const;
const OUTPUT_CORNERS: readonly Point[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const CASES: readonly { readonly name: string; readonly matrix: Matrix }[] = [
  { name: 'upper', matrix: [0.8, 0, 0.1, 0, 0.8, 0.1, 0.05, 0.08, 1] },
  { name: 'left-right', matrix: [0.8, 0, 0.1, 0, 0.8, 0.1, 0.2, 0.1, 1] },
  { name: 'skew', matrix: [0.7, 0.1, 0.1, 0.05, 0.65, 0.15, 0.2, -0.1, 1] },
];

/** 製品 solver に依存しない、既知の有理式からの期待座標。 */
function knownPoint(h: Matrix, [s, t]: Point): Point {
  const denominator = h[6] * s + h[7] * t + h[8];
  return [
    (h[0] * s + h[1] * t + h[2]) / denominator,
    (h[3] * s + h[4] * t + h[5]) / denominator,
  ];
}

/** 既定の100mm幅・80mm高さで貼られた元画像上の点。 */
function imageWorld([u, v]: Point): readonly [number, number, number] {
  return [(u - 0.5) * 100, (0.5 - v) * 80, 0];
}

/** 既定のホーム視点。workPlaneCaptureSupport のクリック式と同じ投影を検査画素に使う。 */
function screenPoint([x, y, z]: readonly [number, number, number], width: number, height: number): Point {
  const azimuth = -Math.PI / 4;
  const elevation = Math.atan(Math.SQRT1_2);
  const eye: readonly [number, number, number] = [
    200 * Math.cos(elevation) * Math.cos(azimuth),
    200 * Math.cos(elevation) * Math.sin(azimuth),
    200 * Math.sin(elevation),
  ];
  const eyeLength = Math.hypot(...eye);
  const cameraZ: readonly [number, number, number] = [
    eye[0] / eyeLength, eye[1] / eyeLength, eye[2] / eyeLength,
  ];
  const horizontalLength = Math.hypot(cameraZ[0], cameraZ[1]);
  const cameraX: readonly [number, number, number] = [-cameraZ[1] / horizontalLength, cameraZ[0] / horizontalLength, 0];
  const cameraY: readonly [number, number, number] = [
    cameraZ[1] * cameraX[2] - cameraZ[2] * cameraX[1],
    cameraZ[2] * cameraX[0] - cameraZ[0] * cameraX[2],
    cameraZ[0] * cameraX[1] - cameraZ[1] * cameraX[0],
  ];
  const delta: readonly [number, number, number] = [x - eye[0], y - eye[1], z - eye[2]];
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const depth = -dot(delta, cameraZ);
  const scale = 1 / Math.tan((50 * Math.PI / 180) / 2);
  const ndcX = scale * dot(delta, cameraX) / (depth * width / height);
  const ndcY = scale * dot(delta, cameraY) / depth;
  return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
}

/**
 * 描画の枠はcanvasの整数のclient寸法(カメラの縦横比と製品の押下位置の基準)で、表示は小数のレイアウト寸法
 * (boundingBox)へ縮尺される。この差(0.1%未満)を解析投影の側で同じに扱う。
 */
async function canvasFrame(page: Page): Promise<{ readonly box: { readonly x: number; readonly y: number;
  readonly width: number; readonly height: number }; readonly width: number; readonly height: number }> {
  const viewport = page.locator('canvas.pcad-viewport__canvas');
  const box = await viewport.boundingBox();
  if (box === null) throw new Error('Missing viewport bounds');
  const frame = await viewport.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  if (frame.width <= 0 || frame.height <= 0) throw new Error('Invalid viewport frame');
  return { box, ...frame };
}

/** 画面(canvas内のCSS座標)から元画像の正規化座標への逆写像。screenPointをNewton法で反転する。 */
function imagePointAt(target: Point, width: number, height: number): Point {
  let uv: Point = [0.5, 0.5];
  const epsilon = 1e-6;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const at = screenPoint(imageWorld(uv), width, height);
    const du = screenPoint(imageWorld([uv[0] + epsilon, uv[1]]), width, height);
    const dv = screenPoint(imageWorld([uv[0], uv[1] + epsilon]), width, height);
    const a = (du[0] - at[0]) / epsilon, c = (du[1] - at[1]) / epsilon;
    const b = (dv[0] - at[0]) / epsilon, d = (dv[1] - at[1]) / epsilon;
    const determinant = a * d - b * c;
    const rx = target[0] - at[0], ry = target[1] - at[1];
    uv = [uv[0] + (d * rx - b * ry) / determinant, uv[1] + (-c * rx + a * ry) / determinant];
  }
  return uv;
}

/** 4点の対応(src→dst)から射影行列を解く。製品のsolverとは別の、部分ピボットの掃き出し法。 */
function solveHomography(src: readonly Point[], dst: readonly Point[]): Matrix {
  const rows: number[][] = [];
  for (const [index, [x, y]] of src.entries()) {
    const target = dst[index];
    if (target === undefined) throw new Error('Missing homography target');
    const [u, v] = target;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(rows[row]?.[column] ?? 0) > Math.abs(rows[pivot]?.[column] ?? 0)) pivot = row;
    }
    const swap = rows[column]; const chosen = rows[pivot];
    if (swap === undefined || chosen === undefined) throw new Error('Invalid homography system');
    rows[column] = chosen; rows[pivot] = swap;
    const lead = chosen[column] ?? 0;
    if (Math.abs(lead) < 1e-12) throw new Error('Singular homography system');
    for (let k = column; k < 9; k += 1) chosen[k] = (chosen[k] ?? 0) / lead;
    for (let row = 0; row < 8; row += 1) {
      const other = rows[row];
      if (row === column || other === undefined) continue;
      const factor = other[column] ?? 0;
      for (let k = column; k < 9; k += 1) other[k] = (other[k] ?? 0) - factor * (chosen[k] ?? 0);
    }
  }
  const h = rows.map(row => row[8] ?? 0);
  return [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0, 1];
}

/**
 * 四隅を整数のCSS座標で押す。ブラウザーが小数のマウス座標を丸める(Firefox等)場合でも、
 * 押した位置を一意に決め、その位置を元画像の座標へ戻した実際の四隅を返す。
 */
async function clickImageCorners(page: Page, targets: readonly Point[]): Promise<readonly Point[]> {
  const { box, width, height } = await canvasFrame(page);
  const actual: Point[] = [];
  for (const target of targets) {
    const [x, y] = screenPoint(imageWorld(target), width, height);
    const pageX = Math.round(box.x + x), pageY = Math.round(box.y + y);
    // 製品は押した位置からcanvasの左上を引いた値をそのまま描画の枠の座標として扱う。
    actual.push(imagePointAt([pageX - box.x, pageY - box.y], width, height));
    await waitForSettledRecompute(page);
    await page.mouse.click(pageX, pageY);
  }
  return actual;
}

/** 実際に押した四隅から、元画像の既知格子点が補正後に現れる平面位置(正規化)を求める。 */
function expectedPlanePositions(matrix: Matrix, pickedQuad: readonly Point[]): readonly Point[] {
  const inverse = solveHomography(pickedQuad, OUTPUT_CORNERS);
  return INTERNAL.flatMap(s => INTERNAL.map(t => {
    const [u, v] = knownPoint(matrix, [s, t]);
    return knownPoint(inverse, [u, v]);
  }));
}

/** 既知の射影先へ9個のマゼンタ点を描く。四隅は画像自体の画素には描かない。 */
async function gridPng(page: Page, matrix: Matrix): Promise<Buffer> {
  const points = INTERNAL.flatMap(s => INTERNAL.map(t => knownPoint(matrix, [s, t])));
  const base64 = await page.evaluate(({ width, height, points }) => {
    const image = document.createElement('canvas');
    image.width = width; image.height = height;
    const context = image.getContext('2d');
    if (context === null) throw new Error('Missing canvas context');
    context.fillStyle = '#555555'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#ff00ff';
    for (const [u, v] of points) {
      context.beginPath(); context.arc(u * width, v * height, 9, 0, Math.PI * 2); context.fill();
    }
    return image.toDataURL('image/png').split(',')[1];
  }, { width: WIDTH, height: HEIGHT, points });
  return Buffer.from(base64, 'base64');
}

interface GridMeasurement {
  readonly grid: Point;
  /** 製品に依存しない解析投影による位置(探索窓の中心)。 */
  readonly analyticCss: Point;
  /** 比べる相手。解析投影に、基準の格子で測った計り方の偏りを足した位置。 */
  readonly expectedCss: Point;
  readonly actualCss: Point | null;
  readonly errorCssPx: number | null;
  /** 解析投影との差。計り方の偏りの記録用。 */
  readonly analyticErrorCssPx: number | null;
}

/** 実WebGL画素のマゼンタ領域の重心を測り、独立Hの格子中心と比べる。 */
async function measureVisibleGrid(page: Page, baseline: readonly GridMeasurement[] | null = null,
  plane: readonly Point[] | null = null): Promise<readonly GridMeasurement[]> {
  const { box, ...frame } = await canvasFrame(page);
  const viewportCss = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (![box.x, box.y, box.width, box.height, viewportCss.width, viewportCss.height].every(Number.isFinite)
    || box.width <= 0 || box.height <= 0 || viewportCss.width <= 0 || viewportCss.height <= 0) {
    throw new Error('Invalid viewport bounds');
  }
  const positions = INTERNAL.flatMap(s => INTERNAL.map(t => [s, t] as Point)).map((grid, index) => {
    const framed = screenPoint(imageWorld(plane?.[index] ?? grid), frame.width, frame.height);
    const analyticCss: Point = [framed[0] * box.width / frame.width, framed[1] * box.height / frame.height];
    const reference = baseline?.[index];
    if (baseline !== null && (reference === undefined || reference.actualCss === null)) {
      throw new Error('Baseline grid has an unmeasured point');
    }
    // 補正しない基準の格子の、解析投影との差(計り方の偏り)を同じ点に足す。
    const bias: Point = reference?.actualCss == null ? [0, 0]
      : [reference.actualCss[0] - reference.analyticCss[0], reference.actualCss[1] - reference.analyticCss[1]];
    return { grid, analyticCss, expectedCss: [analyticCss[0] + bias[0], analyticCss[1] + bias[1]] as Point };
  });
  const png = await page.screenshot({ fullPage: false });
  return page.evaluate(async ({ data, positions, boxX, boxY, viewportWidth, viewportHeight, searchRadius }) => {
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    if (image.width <= 0 || image.height <= 0) throw new Error('Invalid screenshot dimensions');
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Missing screenshot context');
    context.drawImage(image, 0, 0); image.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return positions.map(({ grid, analyticCss, expectedCss }) => {
      const [cssX, cssY] = analyticCss;
      const viewportX = expectedCss[0] + boxX, viewportY = expectedCss[1] + boxY;
      if (viewportX < 0 || viewportX >= viewportWidth || viewportY < 0 || viewportY >= viewportHeight) {
        return { grid, analyticCss, expectedCss, actualCss: null, errorCssPx: null, analyticErrorCssPx: null };
      }
      const minX = Math.max(0, Math.floor((viewportX - searchRadius) * canvas.width / viewportWidth));
      const maxX = Math.min(canvas.width - 1, Math.ceil((viewportX + searchRadius) * canvas.width / viewportWidth));
      const minY = Math.max(0, Math.floor((viewportY - searchRadius) * canvas.height / viewportHeight));
      const maxY = Math.min(canvas.height - 1, Math.ceil((viewportY + searchRadius) * canvas.height / viewportHeight));
      let weight = 0, sumX = 0, sumY = 0;
      for (let sy = minY; sy <= maxY; sy += 1) {
        for (let sx = minX; sx <= maxX; sx += 1) {
          const pixelCssX = (sx + 0.5) * viewportWidth / canvas.width;
          const pixelCssY = (sy + 0.5) * viewportHeight / canvas.height;
          if (Math.hypot(pixelCssX - viewportX, pixelCssY - viewportY) > searchRadius) continue;
          const index = (sy * canvas.width + sx) * 4;
          const red = pixels[index], green = pixels[index + 1], blue = pixels[index + 2];
          if (red <= green + 45 || blue <= green + 45) continue;
          const contribution = Math.min(red, blue) - green;
          weight += contribution;
          sumX += contribution * (pixelCssX - boxX);
          sumY += contribution * (pixelCssY - boxY);
        }
      }
      if (weight === 0) {
        return { grid, analyticCss, expectedCss, actualCss: null, errorCssPx: null, analyticErrorCssPx: null };
      }
      const actualCss: Point = [sumX / weight, sumY / weight];
      return { grid, analyticCss, expectedCss, actualCss,
        errorCssPx: Math.hypot(actualCss[0] - expectedCss[0], actualCss[1] - expectedCss[1]),
        analyticErrorCssPx: Math.hypot(actualCss[0] - cssX, actualCss[1] - cssY) };
    });
  }, { data: png.toString('base64'), positions, boxX: box.x, boxY: box.y,
    viewportWidth: viewportCss.width, viewportHeight: viewportCss.height,
    searchRadius: MARKER_SEARCH_RADIUS_CSS_PX });
}

/** Record both screenshot coordinate systems for the first corrected grid. */
async function attachUpperPixelCoordinates(page: Page, info: TestInfo): Promise<void> {
  const viewport = page.locator('canvas.pcad-viewport__canvas');
  const box = await viewport.boundingBox();
  if (box === null) throw new Error('Missing viewport bounds');
  const dimensions = await viewport.evaluate(element => ({
    clientWidth: element.clientWidth, clientHeight: element.clientHeight,
    width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height,
    dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY,
    pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight,
  }));
  const centerCss = screenPoint(imageWorld([0.5, 0.5]), box.width, box.height);
  const elementPng = await viewport.screenshot();
  const pagePng = await page.screenshot({ fullPage: true });
  await info.attach('canvas-upper-element', { contentType: 'image/png', body: elementPng });
  await info.attach('canvas-upper-full-page', { contentType: 'image/png', body: pagePng });
  const pixels = await page.evaluate(async ({ elementData, pageData, elementCss, pageCss, center, pageCenter,
    radius }) => {
    const centroid = async (data: string, cssSize: readonly [number, number], expected: readonly [number, number]) => {
      const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Missing screenshot context');
      context.drawImage(bitmap, 0, 0); bitmap.close();
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const scaleX = canvas.width / cssSize[0], scaleY = canvas.height / cssSize[1];
      let weight = 0, sumX = 0, sumY = 0;
      const minX = Math.max(0, Math.floor((expected[0] - radius) * scaleX));
      const maxX = Math.min(canvas.width - 1, Math.ceil((expected[0] + radius) * scaleX));
      const minY = Math.max(0, Math.floor((expected[1] - radius) * scaleY));
      const maxY = Math.min(canvas.height - 1, Math.ceil((expected[1] + radius) * scaleY));
      for (let y = minY; y <= maxY; y += 1) for (let x = minX; x <= maxX; x += 1) {
        const cssX = (x + 0.5) / scaleX, cssY = (y + 0.5) / scaleY;
        if (Math.hypot(cssX - expected[0], cssY - expected[1]) > radius) continue;
        const offset = (y * canvas.width + x) * 4;
        const red = rgba[offset], green = rgba[offset + 1], blue = rgba[offset + 2];
        if (red <= green + 45 || blue <= green + 45) continue;
        const contribution = Math.min(red, blue) - green;
        weight += contribution; sumX += contribution * (x + 0.5); sumY += contribution * (y + 0.5);
      }
      return { pngWidth: canvas.width, pngHeight: canvas.height,
        pixelCenter: weight === 0 ? null : [sumX / weight, sumY / weight],
        cssCenter: weight === 0 ? null : [sumX / weight / scaleX, sumY / weight / scaleY] };
    };
    return {
      element: await centroid(elementData, elementCss, center),
      fullPage: await centroid(pageData, pageCss, pageCenter),
    };
  }, { elementData: elementPng.toString('base64'), pageData: pagePng.toString('base64'),
    elementCss: [box.width, box.height] as Point,
    pageCss: [dimensions.pageWidth, dimensions.pageHeight] as Point,
    center: centerCss, pageCenter: [centerCss[0] + box.x + dimensions.scrollX,
      centerCss[1] + box.y + dimensions.scrollY] as Point, radius: MARKER_SEARCH_RADIUS_CSS_PX });
  await info.attach('canvas-upper-pixel-coordinates', { contentType: 'application/json', body: JSON.stringify({
    box, dimensions, centerCss, pageCenterCss: [centerCss[0] + box.x + dimensions.scrollX,
      centerCss[1] + box.y + dimensions.scrollY], pixels,
  }) });
}

async function expectVisibleGrid(page: Page, info: TestInfo, stage: string,
  baseline: readonly GridMeasurement[], plane: readonly Point[]): Promise<void> {
  let measured: readonly GridMeasurement[] = [];
  try {
    await expect.poll(async () => {
      measured = await measureVisibleGrid(page, baseline, plane);
      return measured.length === 9 && measured.every(point =>
        point.errorCssPx !== null && point.errorCssPx <= MAX_CENTER_ERROR_CSS_PX);
    }, { message: `${stage} の内部9点の実画面中心誤差が各${MAX_CENTER_ERROR_CSS_PX} CSS px以内` }).toBe(true);
  } finally {
    if (stage === 'upper-applied') {
      try {
        await attachUpperPixelCoordinates(page, info);
      } catch (error) {
        await info.attach('canvas-upper-observation-error', { contentType: 'text/plain', body: String(error) });
      }
    }
    await info.attach(`canvas-grid-${stage}`, { contentType: 'application/json', body: JSON.stringify({
      maxCenterErrorCssPx: MAX_CENTER_ERROR_CSS_PX, plane,
      markerSearchRadiusCssPx: MARKER_SEARCH_RADIUS_CSS_PX,
      measurements: measured,
    }) });
    // 環境ごとの数値を画面検査のログへ残す(通っても見えるように)。
    const errors = measured.map(point => point.errorCssPx ?? Number.NaN);
    const analytic = measured.map(point => point.analyticErrorCssPx ?? Number.NaN);
    console.log(`[四隅補正の格子] ${JSON.stringify({ project: info.project.name, stage,
      maxErrorCssPx: Math.max(...errors), maxAnalyticErrorCssPx: Math.max(...analytic) })}`);
  }
}

/** PCADの保存はWebではdownload、Electronでは実デスクトップの保存窓を通す。 */
async function savePerspective(page: Page, info: TestInfo, name: string, app?: ElectronApplication): Promise<Buffer> {
  if (app === undefined) return save(page, info, name);
  const path = info.outputPath(name);
  await saveTarget(app, path);
  await fileAction(page, '保存').click({ modifiers: ['Shift'] });
  const bytes = await diskFile(path);
  await expect(page.locator('[data-save-stage="complete"]')).toBeVisible();
  return bytes;
}

/** 保存した実PCADを製品の「開く」で再読込する。 */
async function openPerspective(page: Page, name: string, bytes: Buffer, info: TestInfo,
  app?: ElectronApplication): Promise<void> {
  if (app === undefined) { await open(page, name, bytes); return; }
  await openTarget(app, info.outputPath(name));
  await fileAction(page, '開く').click();
  await waitForSettledRecompute(page);
}

/**
 * 補正しない下絵(同じ9点を元画像の正規化座標へ直接描いたもの)を同じ環境・同じ視点で測る。
 * 環境ごとの描画・取得の座標のずれ(小数のレイアウト位置、キャンバス寸法の丸め、ソフトウェア描画)は
 * 基準にも同じく現れるため、補正後の格子との差だけが射影補正そのものの誤差になる。
 * 基準の解析投影との差は記録だけ行う。
 */
async function measureBaseline(page: Page, info: TestInfo): Promise<readonly GridMeasurement[]> {
  const filename = 'perspective-baseline.png';
  const image = await gridPng(page, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  await addImage(page, filename, image);
  const row = canvasRow(page, filename);
  await expect(row.getByRole('status')).toHaveText('使用可能');
  const opacity = row.getByRole('textbox', { name: `濃さ ${filename}`, exact: true });
  await opacity.fill('1'); await opacity.press('Enter'); await opacity.press('Tab');
  let measured: readonly GridMeasurement[] = [];
  try {
    await expect.poll(async () => {
      measured = await measureVisibleGrid(page);
      return measured.length === 9 && measured.every(point => point.actualCss !== null);
    }, { message: '補正しない基準の格子9点が実画面に見える' }).toBe(true);
  } finally {
    await info.attach('canvas-grid-baseline', { contentType: 'application/json', body: JSON.stringify({
      markerSearchRadiusCssPx: MARKER_SEARCH_RADIUS_CSS_PX, measurements: measured,
    }) });
  }
  await row.getByRole('button', { name: `${filename} を削除`, exact: true }).click();
  await expect(row).toHaveCount(0);
  return measured;
}

const REFUSED_QUADS: readonly { readonly name: string; readonly quad: readonly Point[] }[] = [
  { name: '重なる点', quad: [[0.2, 0.2], [0.2, 0.2], [0.8, 0.8], [0.2, 0.8]] },
  { name: '一直線の3点', quad: [[0.2, 0.2], [0.5, 0.2], [0.8, 0.2], [0.2, 0.8]] },
  { name: '自己交差', quad: [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]] },
  { name: '凹の四角形', quad: [[0.2, 0.2], [0.8, 0.2], [0.45, 0.45], [0.2, 0.8]] },
];

/** 退化した四隅を実UIで拒否し、理由を表示し、文書を変えないことを確かめる。 */
async function expectRefusedQuads(page: Page, info: TestInfo, filename: string): Promise<void> {
  const row = canvasRow(page, filename);
  const begin = row.getByRole('button', { name: `${filename} の四隅を補正する`, exact: true });
  const field = page.locator('.pcad-canvas-rectification');
  const reasons: string[] = [];
  const invalid = '四隅を補正できません';
  for (const { name, quad } of REFUSED_QUADS) {
    await begin.click();
    for (const point of quad) await clickWorldPoint(page, imageWorld(point));
    await field.getByRole('button', { name: '補正する', exact: true }).click();
    await expect(field.getByRole('status'), `${name} は拒否理由を出す`).toContainText(invalid);
    reasons.push(`${name}: ${(await field.getByRole('status').textContent()) ?? ''}`);
    await field.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(field).toHaveCount(0);
    await expect(row.getByRole('button', { name: `${filename} の補正を解除する`, exact: true }),
      `${name} は補正を作らない`).toHaveCount(0);
  }
  await begin.click();
  await clickWorldPoint(page, imageWorld([1.3, 0.5]));
  await expect(field.getByRole('status'), '画像の外の点は拒否理由を出す').toContainText(invalid);
  reasons.push(`画像の外: ${(await field.getByRole('status').textContent()) ?? ''}`);
  await field.getByRole('button', { name: 'やめる', exact: true }).click();
  await expect(field).toHaveCount(0);
  await info.attach(`canvas-refused-${filename}`, { contentType: 'application/json', body: JSON.stringify(reasons) });
}

/** 実 UI で4隅を指定し、独立した射影格子の内部9点と保存画像byteを確認する。 */
export async function canvasPerspectiveFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const baseline = await measureBaseline(page, info);
  for (const { name, matrix } of CASES) {
    const filename = `perspective-${name}.png`;
    const image = await gridPng(page, matrix);
    await addImage(page, filename, image);
    const row = canvasRow(page, filename);
    await expect(row.getByRole('status')).toHaveText('使用可能');
    const opacity = row.getByRole('textbox', { name: `濃さ ${filename}`, exact: true });
    await opacity.fill('1'); await opacity.press('Enter'); await opacity.press('Tab');
    const begin = row.getByRole('button', { name: `${filename} の四隅を補正する`, exact: true });
    const field = page.locator('.pcad-canvas-rectification');
    if (name === 'upper') await expectRefusedQuads(page, info, filename);
    await begin.click();
    await expect(field).toContainText('写真の左上の隅を指してください');
    for (const corner of OUTPUT_CORNERS) await clickWorldPoint(page, imageWorld(knownPoint(matrix, corner)));
    await field.getByRole('button', { name: 'やめる', exact: true }).click();
    await expect(field).toHaveCount(0);
    const cancelled = readPart(await savePerspective(page, info, `perspective-${name}-cancel.pcad`, app));
    expect(cancelled.document.canvases).toHaveLength(1);
    expect(cancelled.document.canvases[0].rectification).toBeUndefined();
    expect(Buffer.from(cancelled.attachments.canvases.get(cancelled.document.canvases[0].imageId) ?? [])).toEqual(image);
    await page.keyboard.press('Control+z');
    await expect(opacity).toHaveValue('0.5');
    await opacity.fill('1'); await opacity.press('Enter'); await opacity.press('Tab');
    await begin.click();
    const picked = await clickImageCorners(page, OUTPUT_CORNERS.map(corner => knownPoint(matrix, corner)));
    const plane = expectedPlanePositions(matrix, picked);
    await field.getByRole('button', { name: '補正する', exact: true }).click();
    await expect(field).toHaveCount(0);
    await expectVisibleGrid(page, info, `${name}-applied`, baseline, plane);
    await page.keyboard.press('Control+z');
    await expect(begin).toBeVisible();
    await page.keyboard.press('Control+y');
    await expectVisibleGrid(page, info, `${name}-redone`, baseline, plane);

    const saved = await savePerspective(page, info, `perspective-${name}.pcad`, app);
    const parsed = readPart(saved);
    expect(parsed.document.canvases).toHaveLength(1);
    const canvas = parsed.document.canvases[0];
    expect(canvas.rectification).toBeDefined();
    const { width: frameWidth, height: frameHeight } = await canvasFrame(page);
    for (const [index, corner] of OUTPUT_CORNERS.entries()) {
      const intended = knownPoint(matrix, corner);
      const actual = canvas.rectification?.sourceQuad[index];
      expect(actual).toBeDefined();
      if (actual === undefined) throw new Error('Saved corner missing');
      // 四隅の誤差は、保存された隅を画面へ写した位置と狙った位置の差(CSS px)で測る。
      const shown = screenPoint(imageWorld(actual), frameWidth, frameHeight);
      const aimed = screenPoint(imageWorld(intended), frameWidth, frameHeight);
      expect(Math.hypot(shown[0] - aimed[0], shown[1] - aimed[1])).toBeLessThanOrEqual(1);
      const pickedCorner = picked[index];
      expect(pickedCorner).toBeDefined();
      if (pickedCorner === undefined) throw new Error('Picked corner missing');
      // 押した位置の元画像座標と保存の隅の差は1 CSS px以内。
      const pickedShown = screenPoint(imageWorld(pickedCorner), frameWidth, frameHeight);
      expect(Math.hypot(shown[0] - pickedShown[0], shown[1] - pickedShown[1])).toBeLessThanOrEqual(1);
    }
    expect(Buffer.from(parsed.attachments.canvases.get(canvas.imageId) ?? [])).toEqual(image);
    await openPerspective(page, `perspective-${name}.pcad`, saved, info, app);
    await expectVisibleGrid(page, info, `${name}-reopened`, baseline, plane);

    await row.getByRole('button', { name: `${filename} の補正を解除する`, exact: true }).click();
    const cleared = readPart(await savePerspective(page, info, `perspective-${name}-clear.pcad`, app));
    expect(cleared.document.canvases).toHaveLength(1);
    expect(cleared.document.canvases[0].rectification).toBeUndefined();
    expect(Buffer.from(cleared.attachments.canvases.get(cleared.document.canvases[0].imageId) ?? [])).toEqual(image);
    await page.keyboard.press('Control+z');
    await expectVisibleGrid(page, info, `${name}-clear-undone`, baseline, plane);
    await row.getByRole('button', { name: `${filename} を削除`, exact: true }).click();
  }
}
