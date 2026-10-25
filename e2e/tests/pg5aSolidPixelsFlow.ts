/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { exactExpressionValueFromNumber, expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { appendSolid, appearanceFromPreset, assignAppearance,
  createEmptyPartDocument, createPrimitiveFeature } from '../../packages/model/src/index.js';
import { readRecomputeStats, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { waitForStartupHealth } from './startupHealth.js';
import { readViewportRenderStats } from './viewportRenderStats.js';

const OFFSETS = [0, 1e6, 1e9] as const;
const SIZES = [0.5, 0.375, 0.25] as const;
const DISTANCE = 2;
const VIEWS = ['top', 'front'] as const;
type View = typeof VIEWS[number];
type Vec3 = readonly [number, number, number];
interface Pixels { readonly width: number; readonly height: number; readonly mask: Buffer }
interface Rectangle { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number }

/** Only feature history is stored. The app must build its own native box and display meshes. */
function fixture(offset: number) {
  const center: Vec3 = [offset + 3 / 128, offset + 5 / 128, offset + 7 / 128];
  const empty = createEmptyPartDocument();
  // absoluteCoordinate rounds values to 12 significant digits; precision fixtures need the exact API.
  const feature = { ...createPrimitiveFeature(empty, 'box', { kind: 'coordinate', value: {
    mode: 'absolute', x: exactExpressionValueFromNumber(center[0]),
    y: exactExpressionValueFromNumber(center[1]), z: exactExpressionValueFromNumber(center[2]) } }),
    id: `pg5a-box-${offset}`, name: `PG5a box ${offset}`,
    shape: { kind: 'box' as const, sizeX: expressionValueFromNumber(SIZES[0]),
      sizeY: expressionValueFromNumber(SIZES[1]), sizeZ: expressionValueFromNumber(SIZES[2]) } };
  const part = appendSolid(empty, feature);
  const cameras = VIEWS.map(view => ({ id: `pg5a-${view}`, name: `PG5a ${view}`,
    target: center,
    position: (view === 'top' ? [center[0], center[1], center[2] + DISTANCE]
      : [center[0], center[1] - DISTANCE, center[2]]) satisfies Vec3,
    up: (view === 'top' ? [0, 1, 0] : [0, 0, 1]) satisfies Vec3,
    projection: 'orthographic' as const, zoom: 1 }));
  const document = { ...part, id: `pg5a-part-${offset}`, namedViews: cameras,
    appearance: assignAppearance(part.appearance, { kind: 'body', bodyFeatureId: feature.id },
      appearanceFromPreset('plastic', '#ff00ff')) };
  const bytes = writePcadFile(document, { savedAt: '2026-09-09T00:00:00.000Z' });
  const readback = readPcadFile(bytes);
  if (!readback.ok) throw new Error(readback.error.message);
  const stored = readback.document.solids[0];
  if (stored?.kind !== 'primitive' || stored.origin.kind !== 'coordinate' || stored.origin.value.mode !== 'absolute') {
    throw new Error('Precision fixture must store an ordinary primitive with absolute coordinates');
  }
  const coordinates = [stored.origin.value.x, stored.origin.value.y, stored.origin.value.z];
  expect(coordinates.map(value => value.value), 'Stored geometry uses the designed double center').toEqual(center);
  expect(coordinates.map(value => value.source), 'Stored source preserves every coordinate digit').toEqual(center.map(String));
  return { document, feature, center, cameras, bytes };
}

async function restoreAndRemember(page: Page, view: View): Promise<void> {
  const menu = page.locator('.pcad-named-views');
  await menu.locator('summary').click();
  await menu.getByRole('combobox', { name: '視点を選ぶ', exact: true }).selectOption(`pg5a-${view}`);
  const before = await readViewportRenderStats(page);
  await menu.getByRole('button', { name: 'この視点へ', exact: true }).click();
  await menu.getByRole('textbox', { name: '視点の名前', exact: true }).fill(`PG5a actual ${view}`);
  await menu.getByRole('button', { name: '今の視点を保存', exact: true }).click();
  await expect(menu.getByRole('option', { name: `PG5a actual ${view}`, exact: true })).toHaveCount(1);
  await menu.locator('summary').click();
  await page.mouse.move(0, 0);
  // Existing render-counter observation; no sleep standing in for a completed frame.
  await expect.poll(async () => {
    const stats = await readViewportRenderStats(page);
    return stats.completedRenders > before.completedRenders
      && await page.evaluate(last => performance.now() - last > 350, stats.lastCompletedAtMs);
  }, { timeout: 10_000, message: 'Named camera completed a real render and settled' }).toBe(true);
}

/** Read the currently admitted ordinary Part; never inject a body, frame, receipt or owner. */
async function publication(page: Page, featureId: string, generation: number) {
  return page.evaluate(({ featureId, generation }) => {
    const read = (name: string): Record<string, unknown> => {
      const getter: unknown = Reflect.get(window, name);
      if (typeof getter !== 'function') throw new Error(`Missing actual observation: ${name}`);
      const value: unknown = getter();
      if (value === null || typeof value !== 'object') throw new Error(`Invalid observation: ${name}`);
      return Object.fromEntries(Object.entries(value));
    };
    const owner = read('pcadViewportAssemblyOwner'), mesh = read('pcadViewportMeshObservation');
    const ids = window.pcadViewportFramedBodies?.(); // This calls the live solid-owner admission check.
    if (ids?.length !== 1 || ids[0] !== featureId || owner.assemblyIdentity !== null || owner.drawingIdentity !== null
      || owner.requestedGeneration !== generation || owner.completedGeneration !== generation
      || owner.lastOutcome !== 'success' || owner.recomputeCancelled !== false
      || typeof owner.activeDocumentId !== 'string' || owner.activeDocumentId.length === 0
      || owner.viewportOwnerId !== mesh.viewportOwnerId || mesh.active !== true || !Array.isArray(mesh.events)) {
      throw new Error('Current ordinary Part/frame owner unavailable');
    }
    const events: unknown[] = mesh.events;
    const publications = events.filter((event): event is Record<string, unknown> => event !== null
      && typeof event === 'object' && 'kind' in event && event.kind === 'publish-complete');
    const latest = publications.at(-1);
    if (latest === undefined || latest.documentId !== owner.activeDocumentId || latest.generation !== generation
      || latest.viewportOwnerId !== owner.viewportOwnerId || latest.preview !== false
      || typeof latest.publicationId !== 'string' || typeof latest.hostGpuAttributeBytes !== 'number'
      || latest.hostGpuAttributeBytes <= 0) throw new Error('Current real mesh publication missing');
    return { featureId, documentId: owner.activeDocumentId, viewportOwnerId: owner.viewportOwnerId,
      generation, publicationId: latest.publicationId, gpuAttributeBytes: latest.hostGpuAttributeBytes };
  }, { featureId, generation });
}

/** Browser PNG decode follows referenceAmbiguityFlow; reads pixels of an actual Playwright screenshot. */
async function decodePixels(page: Page, png: Buffer): Promise<Pixels> {
  const decoded = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
      const target = new OffscreenCanvas(image.width, image.height), context = target.getContext('2d');
      if (context === null) throw new Error('Actual PNG decode unavailable');
      context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, image.width, image.height).data;
      const mask = new Uint8Array(image.width * image.height);
      for (let pixel = 0; pixel < mask.length; pixel += 1) {
        const r = rgba[pixel * 4], g = rgba[pixel * 4 + 1], b = rgba[pixel * 4 + 2];
        // Saturated opaque magenta material; grayscale background and RGB axes do not qualify.
        mask[pixel] = r >= 70 && b >= 70 && Math.min(r, b) > g + 40 ? 1 : 0;
      }
      let binary = '';
      for (let start = 0; start < mask.length; start += 8192) binary += String.fromCharCode(...mask.subarray(start, start + 8192));
      return { width: image.width, height: image.height, mask: btoa(binary) };
    } finally { image.close(); }
  }, png.toString('base64'));
  return { width: decoded.width, height: decoded.height, mask: Buffer.from(decoded.mask, 'base64') };
}

/** Independent double pinhole/orthographic specification, not a product projection or mesh readback. */
function expectedRectangle(pixels: Pixels, view: View): Rectangle {
  const pixelsPerMm = pixels.height / (2 * DISTANCE * Math.tan(50 * Math.PI / 360));
  const halfX = SIZES[0] * pixelsPerMm / 2;
  const halfY = SIZES[view === 'top' ? 1 : 2] * pixelsPerMm / 2;
  return { left: pixels.width / 2 - halfX, right: pixels.width / 2 + halfX,
    top: pixels.height / 2 - halfY, bottom: pixels.height / 2 + halfY };
}

function inspectSilhouette(pixels: Pixels, rectangle: Rectangle) {
  const { width, height, mask } = pixels;
  expect(mask.length).toBe(width * height);
  let colored = 0, missingInterior = 0, outsideError = 0, boundaryError = 0;
  const rowMin = Array<number>(height).fill(width), rowMax = Array<number>(height).fill(-1);
  const colMin = Array<number>(width).fill(height), colMax = Array<number>(width).fill(-1);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const px = x + 0.5, py = y + 0.5;
    if (mask[y * width + x] !== 0) {
      colored += 1;
      rowMin[y] = Math.min(rowMin[y], x); rowMax[y] = Math.max(rowMax[y], x);
      colMin[x] = Math.min(colMin[x], y); colMax[x] = Math.max(colMax[x], y);
      outsideError = Math.max(outsideError, Math.hypot(Math.max(rectangle.left - px, 0, px - rectangle.right),
        Math.max(rectangle.top - py, 0, py - rectangle.bottom)));
    } else if (px > rectangle.left + 1 && px < rectangle.right - 1
      && py > rectangle.top + 1 && py < rectangle.bottom - 1) missingInterior += 1;
  }
  // Pixel-cell edges bracket the measured silhouette. No extra AA tolerance is added to 1px.
  for (let y = Math.ceil(rectangle.top + 1); y < Math.floor(rectangle.bottom - 1); y += 1) {
    boundaryError = Math.max(boundaryError, Math.abs(rowMin[y] - rectangle.left), Math.abs(rowMax[y] + 1 - rectangle.right));
  }
  for (let x = Math.ceil(rectangle.left + 1); x < Math.floor(rectangle.right - 1); x += 1) {
    boundaryError = Math.max(boundaryError, Math.abs(colMin[x] - rectangle.top), Math.abs(colMax[x] + 1 - rectangle.bottom));
  }
  return { colored, missingInterior, outsideError, boundaryError };
}

/** Symmetric nearest-pixel distance <=1, including the whole silhouette, with no image alignment. */
function mismatchesBeyondOnePixel(a: Pixels, b: Pixels): number {
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  let misses = 0;
  const directed = (source: Buffer, target: Buffer): void => {
    for (let i = 0; i < source.length; i += 1) {
      if (source[i] === 0 || target[i] !== 0) continue;
      const x = i % a.width, y = Math.floor(i / a.width);
      if (x > 0 && target[i - 1] !== 0 || x + 1 < a.width && target[i + 1] !== 0
        || y > 0 && target[i - a.width] !== 0 || y + 1 < a.height && target[i + a.width] !== 0) continue;
      misses += 1;
    }
  };
  directed(a.mask, b.mask); directed(b.mask, a.mask);
  return misses;
}

export async function pg5aSolidPixels(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const canvas = page.locator('canvas.pcad-viewport__canvas');
  const baseline = new Map<View, Pixels>();
  let originalGeometry: { cssWidth: number; cssHeight: number; bufferWidth: number; bufferHeight: number; dpr: number } | undefined;
  await page.getByRole('button', { name: '面のみ', exact: true }).click();
  const grid = page.getByRole('button', { name: 'グリッド', exact: true });
  if (await grid.getAttribute('aria-pressed') === 'true') await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  for (const offset of OFFSETS) {
    const input = fixture(offset), path = info.outputPath(`pg5a-${offset}.pcad`);
    await writeFile(path, input.bytes);
    await openSaveFlowFile(page, path, app); // Existing normal file open + real generation-bound recompute.
    const recompute = await waitForSettledRecompute(page);
    expect(recompute.lastOutcome).toBe('success');
    await expect(page.locator('.pcad-panel--left').getByRole('button', { name: input.feature.name, exact: true })).toBeVisible();
    for (const view of VIEWS) {
      await restoreAndRemember(page, view);
      const before = await publication(page, input.feature.id, recompute.completedGeneration);
      const geometry = await canvas.evaluate(element => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error('Viewport canvas unavailable');
        const bounds = element.getBoundingClientRect();
        return { cssWidth: bounds.width, cssHeight: bounds.height,
          bufferWidth: element.width, bufferHeight: element.height, dpr: devicePixelRatio };
      });
      if (originalGeometry === undefined) originalGeometry = geometry;
      expect(geometry, 'The same camera scale and drawing buffer across every offset/view').toEqual(originalGeometry);
      const png = await canvas.screenshot({ scale: 'device' });
      await info.attach(`pg5a-${offset}-${view}.png`, { body: png, contentType: 'image/png' });
      const pixels = await decodePixels(page, png);
      expect(Math.abs(pixels.width - geometry.cssWidth * geometry.dpr)).toBeLessThanOrEqual(1);
      expect(Math.abs(pixels.height - geometry.cssHeight * geometry.dpr)).toBeLessThanOrEqual(1);
      const expected = expectedRectangle(pixels, view), measurement = inspectSilhouette(pixels, expected);
      const nearOrigin = baseline.get(view);
      const differingPixels = nearOrigin === undefined ? 0 : mismatchesBeyondOnePixel(nearOrigin, pixels);
      const after = await publication(page, input.feature.id, recompute.completedGeneration);
      expect(after, 'Same current owner around the real screenshot').toEqual(before);
      await info.attach(`pg5a-${offset}-${view}-measurement.json`, { body: JSON.stringify({ offset, view, geometry,
        image: { width: pixels.width, height: pixels.height }, expected, measurement, differingPixels, before, after }),
      contentType: 'application/json' });
      expect(measurement.colored, 'Actual opaque solid pixels, not an empty screenshot').toBeGreaterThan(100);
      expect(measurement.missingInterior, 'No missing native face inside the independent double rectangle').toBe(0);
      expect(measurement.outsideError, 'Actual face pixels outside the independent boundary').toBeLessThanOrEqual(1);
      expect(measurement.boundaryError, 'Every actual row/column silhouette vs independent double projection').toBeLessThanOrEqual(1);
      expect(differingPixels, 'Whole actual origin/far masks agree within 1 physical pixel').toBe(0);
      if (nearOrigin === undefined) baseline.set(view, pixels);
    }
    // Capture cameras via the product's normal save path and inspect the actual saved values.
    const saved = readPcadFile(new Uint8Array(await saveFlowFile(page, info.outputPath(`pg5a-${offset}-saved.pcad`), app)));
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.document.solids).toEqual(input.document.solids);
    expect(saved.document.appearance).toEqual(input.document.appearance);
    for (const view of VIEWS) {
      const actual = saved.document.namedViews.find(value => value.name === `PG5a actual ${view}`);
      const expected = input.cameras.find(value => value.id === `pg5a-${view}`);
      if (actual === undefined || expected === undefined) throw new Error('Actual saved camera missing');
      expect(actual.target).toEqual(expected.target); expect(actual.up).toEqual(expected.up);
      expect(actual.projection).toBe('orthographic'); expect(actual.zoom).toBe(1);
      for (let axis = 0; axis < 3; axis += 1) expect(Math.abs(actual.position[axis] - expected.position[axis])).toBeLessThanOrEqual(1e-7);
    }
    const final = await readRecomputeStats(page);
    expect(final.completedGeneration).toBe(recompute.completedGeneration);
    expect(final.lastOutcome).toBe('success');
    expect(errors).toEqual([]);
  }
}
