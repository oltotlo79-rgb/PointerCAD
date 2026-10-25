import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { applicationInputDigest, CAPTURE_SCREEN_REQUIREMENTS, classifyCaptureViewport } from '../../scripts/manual/captureRegistry.mjs';
import { sourceFileHash } from '../../scripts/release/desktopFileInventory.mjs';
import { readRecomputeStats, waitForSettledRecompute } from './recompute.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface CaptureDiagnosticEvent {
  readonly kind: 'render' | 'canvas-resize' | 'window-resize' | 'window-scroll' | 'panel-scroll' | 'pointer';
  readonly atMs: number;
  readonly before?: number | null;
  readonly after?: number | null;
  readonly scheduledAtMs?: number;
  readonly scheduleStack?: string;
  readonly executionStack?: string;
  /** Pointer events only: the event, where it was, whether the browser marked it trusted, and the element it reached. */
  readonly type?: string;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly trusted?: boolean;
  readonly target?: string;
  readonly canvas: {
    readonly clientWidth: number;
    readonly clientHeight: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly panelScrollTop: number | null;
}

interface CaptureDiagnosticReport {
  readonly events: readonly CaptureDiagnosticEvent[];
  readonly dropped: number;
}

declare global {
  interface Window {
    pcadCaptureDiagnostic?: { stop: () => CaptureDiagnosticReport };
  }
}

/** Temporary observation only; it does not request a draw or alter screenshot assertions. */
async function startCaptureDiagnostic(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.pcadCaptureDiagnostic !== undefined) throw new Error('Capture diagnostic is already active');
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const events: CaptureDiagnosticEvent[] = [];
    let dropped = 0;
    let active = true;
    const panel = document.querySelector<HTMLElement>('.pcad-panel--right');
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.pcad-viewport__canvas');
    const record = (event: Omit<CaptureDiagnosticEvent, 'atMs' | 'canvas' | 'scrollX' | 'scrollY' | 'panelScrollTop'>): void => {
      if (events.length >= 128) { dropped += 1; return; }
      const currentCanvas = document.querySelector<HTMLCanvasElement>('canvas.pcad-viewport__canvas');
      const bounds = currentCanvas?.getBoundingClientRect();
      events.push({ ...event, atMs: performance.now(),
        canvas: currentCanvas === null || bounds === undefined ? null : {
          clientWidth: currentCanvas.clientWidth, clientHeight: currentCanvas.clientHeight,
          x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
        },
        scrollX: window.scrollX, scrollY: window.scrollY, panelScrollTop: panel?.scrollTop ?? null });
    };
    const tracedRequestAnimationFrame = (callback: FrameRequestCallback): number => {
      const scheduledAtMs = performance.now();
      const scheduleStack = new Error().stack?.slice(0, 1_600) ?? '';
      return originalRequestAnimationFrame.call(window, timestamp => {
        if (!active) { callback(timestamp); return; }
        const before = window.pcadViewportRenderStats?.().completedRenders ?? null;
        try { callback(timestamp); }
        finally {
          const after = window.pcadViewportRenderStats?.().completedRenders ?? null;
          if (before !== after) record({ kind: 'render', before, after, scheduledAtMs, scheduleStack,
            executionStack: new Error().stack?.slice(0, 1_600) ?? '' });
        }
      });
    };
    const observer = canvas === null ? null : new ResizeObserver(() => { record({ kind: 'canvas-resize' }); });
    const onWindowResize = (): void => { record({ kind: 'window-resize' }); };
    const onWindowScroll = (): void => { record({ kind: 'window-scroll' }); };
    const onPanelScroll = (): void => { record({ kind: 'panel-scroll' }); };
    // Pointer events the test never sends while capturing (e.g. from the desktop's own cursor), seen at the window first.
    const pointerTypes = ['pointerover', 'pointerout', 'pointerleave', 'pointermove'];
    const onPointer = (event: Event): void => {
      if (!(event instanceof PointerEvent)) return;
      const element = event.target instanceof Element ? event.target : null;
      const className = element?.classList.item(0) ?? null;
      record({ kind: 'pointer', type: event.type, clientX: event.clientX, clientY: event.clientY, trusted: event.isTrusted,
        target: element === null ? String(event.target) : `${element.tagName.toLowerCase()}${className === null ? '' : `.${className}`}` });
    };
    const stop = (): CaptureDiagnosticReport => {
      active = false;
      window.requestAnimationFrame = originalRequestAnimationFrame;
      observer?.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('scroll', onWindowScroll);
      panel?.removeEventListener('scroll', onPanelScroll);
      for (const type of pointerTypes) window.removeEventListener(type, onPointer, { capture: true });
      delete window.pcadCaptureDiagnostic;
      return { events, dropped };
    };
    try {
      window.requestAnimationFrame = tracedRequestAnimationFrame;
      if (canvas !== null) observer?.observe(canvas);
      window.addEventListener('resize', onWindowResize);
      window.addEventListener('scroll', onWindowScroll, { passive: true });
      panel?.addEventListener('scroll', onPanelScroll, { passive: true });
      for (const type of pointerTypes) window.addEventListener(type, onPointer, { capture: true, passive: true });
      window.pcadCaptureDiagnostic = { stop };
    } catch (error) {
      stop();
      throw error;
    }
  });
}

async function stopCaptureDiagnostic(page: Page): Promise<CaptureDiagnosticReport> {
  return page.evaluate(() => window.pcadCaptureDiagnostic?.stop() ?? { events: [], dropped: 0 });
}

/**
 * PCAD_CAPTURE_DIAG=1 records anywhere and =0 nowhere. Unset, it records only in the Linux CI, the one place where the
 * 3D view has drawn while capturing (see dialogImageFromScreen), so that the next such capture leaves its cause in the
 * log (captureDiagnosticSummary) and in the test output (`<name>-screen-diagnostic.json`; on a failure also every
 * attempt's two images). Observing never requests a drawing and never changes what a capture must satisfy.
 */
function captureDiagnosticEnabled(): boolean {
  const setting = process.env.PCAD_CAPTURE_DIAG;
  return setting === '1' || (setting !== '0' && process.platform === 'linux' && process.env.CI === 'true');
}

/** One log line for a capture during which the 3D view drew or pointer events arrived, else null (the JSON has the rest). */
function captureDiagnosticSummary(screenName: string, report: CaptureDiagnosticReport): string | null {
  const notable = report.events.filter(event => event.kind === 'render' || event.kind === 'pointer');
  if (notable.length === 0) return null;
  const shown = notable.slice(0, 16).map(event => (event.kind === 'render'
    ? `render ${String(event.before)}->${String(event.after)}`
    : `${event.type ?? 'pointer'}(${String(event.clientX)},${String(event.clientY)})${event.trusted === false ? ' untrusted' : ''} ${event.target ?? ''}`));
  const more = notable.length - shown.length;
  return `${screenName}: ${String(notable.length)} drawings/pointer events while capturing: ${shown.join('; ')}`
    + (more > 0 ? `; ${String(more)} more in the JSON` : '') + (report.dropped > 0 ? `; ${String(report.dropped)} events not recorded` : '');
}

/**
 * Electron's window content area is smaller than the outer window by its native chrome (title bar,
 * borders) — e.g. 1427x865 instead of the registry's 1440x900 (scripts/manual/captureRegistry.mjs,
 * CAPTURE_VIEWPORT_POLICY) — so it can never match the Web-only viewport policy. The manual's images
 * are always captured from the Web build (Chromium/firefox project), never from Electron, and the size
 * safeguard for those images lives in the registry and the pre-release consistency check, not here.
 * Matches the Electron project names in e2e/playwright.config.ts ('electron', 'startup-electron').
 */
const ELECTRON_PROJECT_NAME = /electron/u;
function isElectronProject(projectName: string): boolean {
  return ELECTRON_PROJECT_NAME.test(projectName);
}

/**
 * Not a Git commit id (2026-09-24 coordinator decision): committing a newly captured screenshot and
 * its capture record changes HEAD, which would immediately mark every already captured image as
 * belonging to an "old" build again. `applicationInputDigest` fingerprints the app's own build inputs
 * instead and excludes the manual's own docs/images, so registering a new image never changes it.
 * Computed once per worker process; it hashes the whole Web input set, so it is not cheap.
 */
let cachedApplicationBuildId: Promise<string> | null = null;
function resolveApplicationBuildId(): Promise<string> {
  if (cachedApplicationBuildId === null) cachedApplicationBuildId = applicationInputDigest(projectRoot);
  return cachedApplicationBuildId;
}

/**
 * The 3D view's finished drawings once no drawing is pending any more (two animation frames without a new
 * one), or null on a screen without the 3D view. captureManualDetail requires the same value after
 * photographing, so a picture taken while the view was still being drawn is never recorded as finished.
 */
async function settledViewportRender(page: Page): Promise<{ readonly completedRenders: number; readonly lastCompletedAtMs: number } | null> {
  const read = () => page.evaluate(async () => {
    const stats = window.pcadViewportRenderStats;
    if (stats === undefined) return null;
    const before = stats().completedRenders;
    // A draw requested inside the watched frames (e.g. the ResizeObserver after setViewportSize) runs in
    // the next frame, possibly after this page's own animation-frame callback. So watch three frames and
    // then a task after the last one, by which time such a draw has run and is counted.
    // A hidden page may not run animation frames; then it cannot draw either, so a short timer suffices.
    const frame = () => new Promise(done => { requestAnimationFrame(done); });
    await Promise.race([frame().then(frame).then(frame).then(() => new Promise(done => { setTimeout(done, 0); })),
      new Promise(done => { setTimeout(done, 1_000); })]);
    const { completedRenders, lastCompletedAtMs } = stats();
    return completedRenders === before && completedRenders > 0 ? { completedRenders, lastCompletedAtMs } : 'drawing' as const;
  });
  // Settled only when two consecutive reads agree: one quiet read right after setViewportSize ended just
  // before such a draw in real Electron (gate 20260928-133915: one 30-40 ms read, then one more draw while capturing).
  const latest: { value: Awaited<ReturnType<typeof read>> } = { value: 'drawing' };
  let previous: number | null = null;
  await expect.poll(async () => {
    const value = await read();
    const stable = value === null || (value !== 'drawing' && value.completedRenders === previous);
    previous = value === null || value === 'drawing' ? null : value.completedRenders;
    latest.value = value;
    return stable ? value : 'drawing';
  }, { message: '3D表示の描画が落ち着いてから撮影する', timeout: 15_000 }).not.toBe('drawing');
  return latest.value === 'drawing' ? null : latest.value;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The pixels of an 8-bit RGB or RGBA picture, row after row. */
interface ScreenshotPixels {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly pixels: Buffer;
}

/** The Paeth predictor of the PNG specification (row filter type 4). */
function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left), toUp = Math.abs(estimate - up), toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

/** The pixels of a screenshot PNG as browsers write it (8-bit RGB or RGBA, not interlaced); anything else is refused. */
function decodeScreenshotPng(png: Buffer): ScreenshotPixels {
  if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error('The screen image is not a PNG');
  }
  let header: Buffer | null = null;
  const compressed: Buffer[] = [];
  for (let offset = PNG_SIGNATURE.length; ;) {
    if (offset + 12 > png.length) throw new Error('The screen image PNG ends without IEND');
    const length = png.readUInt32BE(offset), end = offset + 8 + length;
    if (end + 4 > png.length) throw new Error('The screen image PNG ends inside a chunk');
    if (crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end)) throw new Error('The screen image PNG has a damaged chunk');
    const type = png.toString('latin1', offset + 4, offset + 8), body = png.subarray(offset + 8, end);
    if (type === 'IEND') break;
    if (type === 'IHDR') header = body;
    else if (type === 'IDAT') compressed.push(body);
    offset = end + 4;
  }
  if (header === null || header.length !== 13) throw new Error('The screen image PNG has no header');
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  const [depth, colorType, compression, filter, interlace] = header.subarray(8, 13);
  if (depth !== 8 || (colorType !== 2 && colorType !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error(`Unsupported screen image PNG (depth ${String(depth)}, color type ${String(colorType)}, interlace ${String(interlace)})`);
  }
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const rows = inflateSync(Buffer.concat(compressed));
  if (rows.length !== height * (stride + 1)) throw new Error('The screen image PNG has the wrong amount of pixel data');
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const kind = rows[y * (stride + 1)], source = y * (stride + 1) + 1, row = y * stride, above = row - stride;
    if (kind > 4) throw new Error(`Unsupported PNG row filter ${String(kind)}`);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? pixels[row + i - channels] : 0;
      const up = y > 0 ? pixels[above + i] : 0;
      const upLeft = y > 0 && i >= channels ? pixels[above + i - channels] : 0;
      const predicted = kind === 0 ? 0 : kind === 1 ? left : kind === 2 ? up : kind === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      pixels[row + i] = (rows[source + i] + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function pngChunk(type: string, body: Buffer): Buffer {
  const chunk = Buffer.alloc(body.length + 12);
  chunk.writeUInt32BE(body.length, 0);
  chunk.write(type, 4, 'latin1');
  body.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

/** A PNG of `image` (rows unfiltered, then deflated) that any PNG reader opens. */
function encodeScreenshotPng(image: ScreenshotPixels): Buffer {
  const stride = image.width * image.channels, rows = Buffer.alloc(image.height * (stride + 1));
  for (let y = 0; y < image.height; y += 1) image.pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = image.channels === 4 ? 6 : 2;
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * The dialog image of a real Electron capture, cut out of the screen image just taken (the same pixels of the same
 * picture), or null when the dialog does not lie wholly on that picture; then the element itself is photographed.
 *
 * Chromium photographs an element (Page.captureScreenshot with a clip) by shrinking the web view to the clip for that
 * one picture and growing it back. In a real window the windowing system answers each change with a pointer event at
 * the desktop's own cursor, which the test never moves. On the Linux CI (xvfb without a window manager) that cursor rests
 * on the 3D view, near page point (640, 450): every dialog image sent the page a pointerleave and a pointermove there,
 * and the sketch tools redrew their hover and snap marks while it was taken. CI runs 37248862600 and 39927472338 (ADD-1
 * intersections, real Electron): settled 22/24/26 and 23/25/27, each +2 after the dialog image and never after the
 * screen image. The Linux pictures also show what that cursor did: the line tool's 240° guide and snap mark on
 * intersection-created-screen.png and the red trim preview gone from intersection-trim-preview-screen.png, unlike
 * Windows and firefox. The whole-window picture never resizes the view. Headless browsers have no desktop cursor, and
 * their dialog images supply the manual (CAPTURE_SCREEN_REQUIREMENTS), so they keep photographing the element.
 */
async function dialogImageFromScreen(page: Page, dialog: Locator, screen: Buffer): Promise<Buffer | null> {
  const box = await dialog.boundingBox();
  if (box === null) return null;
  // The size the screen image was taken at: Playwright's emulated viewport, else the window's inner size.
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // The rectangle Playwright's element screenshot takes (its enclosingIntRect), in CSS pixels.
  const left = Math.floor(box.x + 1e-3), top = Math.floor(box.y + 1e-3);
  const right = Math.ceil(box.x + box.width - 1e-3), bottom = Math.ceil(box.y + box.height - 1e-3);
  if (left < 0 || top < 0 || right > viewport.width || bottom > viewport.height || right <= left || bottom <= top) return null;
  const image = decodeScreenshotPng(screen);
  const scaleX = image.width / viewport.width, scaleY = image.height / viewport.height;
  const x0 = Math.round(left * scaleX), y0 = Math.round(top * scaleY);
  const width = Math.min(image.width, Math.round(right * scaleX)) - x0, height = Math.min(image.height, Math.round(bottom * scaleY)) - y0;
  const stride = image.width * image.channels, rowBytes = width * image.channels, pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const start = (y0 + y) * stride + x0 * image.channels;
    image.pixels.copy(pixels, y * rowBytes, start, start + rowBytes);
  }
  return encodeScreenshotPng({ width, height, channels: image.channels, pixels });
}

/**
 * How many times in all one pair of images may be taken when the 3D view drew again while it was being taken.
 * CI run 36506536360 (commit eae0101, the first run with the check below): 11 captures on Linux (1 Chromium
 * sheet-profile, 10 real Electron) saw 1-2 more finished drawings between the settled read and the end of the
 * capture, while the same specs never did on Windows (runs 20260929-112131 / -115159). Such a pair is never
 * kept as it is: it is taken again once the view has settled again, and a view that keeps drawing still fails.
 * CI run 36544970638 (commit cbdc2a5): 4 real Electron captures on Linux drew exactly once more on every one of
 * the 3 attempts, always while the dialog image was taken and never while the screen image was, although other
 * Electron captures of the same size and place (e.g. loft-spline-smooth, 280x802 at the right edge) did not.
 * The cause, found from CI runs 37248862600 and 39927472338: photographing the dialog element resized the web view,
 * and the desktop's cursor then sent pointer events into the 3D view (see dialogImageFromScreen). Real Electron
 * therefore cuts the dialog image out of the screen image whenever the dialog lies wholly on it.
 * The view redraws on every store change (packages/ui/src/viewport/ViewportCanvas.tsx), and on Windows the
 * same images come out byte for byte the same from run to run, so such a redraw does not have to change a
 * single pixel. What such a redraw leaves on the pictures is therefore judged by the pictures themselves: a pair
 * taken again after the view has settled again is kept only when both images are byte-identical to the pair
 * before it (see captureStillImages).
 */
const CAPTURE_ATTEMPTS = 3;

/**
 * The screen and dialog images of a finished 3D view (if any): either the view finished no drawing at all while
 * both were taken, or it drew again but the pair taken again after it had settled again is byte-identical in both
 * images to the pair before it, so what it drew did not change a single pixel of either picture. A redraw that
 * changes what is on the pictures (a view still being drawn or moved) never yields two identical pairs and fails.
 */
async function captureStillImages(page: Page, info: TestInfo, dialog: Locator, names: { readonly screen: string; readonly detail: string }) {
  const readRenders = () => page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders);
  let previous: { readonly screen: Buffer; readonly detail: Buffer } | null = null;
  const diagnosticEnabled = captureDiagnosticEnabled();
  // A real Electron window resizes its web view to photograph an element, and its cursor then moves the pointer (see dialogImageFromScreen).
  const cutDialogOutOfScreen = isElectronProject(info.project.name);
  const attempts: Array<{ readonly screen: Buffer; readonly detail: Buffer; readonly settled: number | null;
    readonly afterScreen: number | null | undefined; readonly afterDetail: number | null | undefined;
    readonly detailFrom: 'screen image' | 'element' }> = [];
  if (diagnosticEnabled) await startCaptureDiagnostic(page);
  let failed = false;
  try {
    for (let attempt = 1; ; attempt += 1) {
      const viewportRender = await settledViewportRender(page);
      // Reuse this already prepared, stable screen; do not add another operation or alter focus.
      // The whole screen includes the toolbar and property fields surrounding the photographed dialog.
      const controlDescriptions = await assertRenderedControlDescriptions(page.locator('body'));
      const screen = await page.screenshot({ path: info.outputPath(names.screen), animations: 'disabled' });
      const afterScreen = viewportRender === null ? null : await readRenders();
      const cut = cutDialogOutOfScreen ? await dialogImageFromScreen(page, dialog, screen) : null;
      if (cut !== null) await writeFile(info.outputPath(names.detail), cut);
      const detail = cut ?? await dialog.screenshot({ path: info.outputPath(names.detail), animations: 'disabled' });
      const images = { viewportRender, controlDescriptions, screen, detail };
      const afterDetail = viewportRender === null ? null : await readRenders();
      if (diagnosticEnabled) attempts.push({ screen, detail, settled: viewportRender?.completedRenders ?? null,
        afterScreen, afterDetail, detailFrom: cut === null ? 'element' : 'screen image' });
      if (viewportRender === null) return images;
      const settled = viewportRender.completedRenders;
      if (afterScreen === settled && afterDetail === settled) return images;
      // Only a view that is still there and drew more is taken again; a vanished view or a lower count fails at once.
      const drewAgain = typeof afterScreen === 'number' && typeof afterDetail === 'number' && afterScreen >= settled && afterDetail >= afterScreen;
      const drawn = `settled ${String(settled)}, after the screen image ${String(afterScreen)}, after the dialog image ${String(afterDetail)}`;
      if (drewAgain && previous !== null && previous.screen.equals(screen) && previous.detail.equals(detail)) {
        // Recorded in the output and the report, never hidden: the redraw is kept only because it changed no pixel.
        const note = `${names.screen}: the 3D view drew again while capturing (${drawn}), but both images are byte-identical `
          + `to the pair taken before the view settled again; kept on attempt ${String(attempt)}/${String(CAPTURE_ATTEMPTS)}`;
        console.log(`[撮影の一致] ${note}`);
        info.annotations.push({ type: 'capture-identical-retake', description: note });
        return images;
      }
      if (!drewAgain || attempt >= CAPTURE_ATTEMPTS) {
        const changed = previous === null ? '' : `; the images differ from the pair taken before (screen ${String(!previous.screen.equals(screen))}, dialog ${String(!previous.detail.equals(detail))})`;
        expect({ afterScreen, afterDetail }, `The 3D view must not redraw while capturing (attempt ${String(attempt)}/${String(CAPTURE_ATTEMPTS)}: ${drawn}${changed})`)
          .toEqual({ afterScreen: settled, afterDetail: settled });
        return images;
      }
      // Recorded in the output and the report, never hidden: the retaken pair replaces this one.
      const note = `${names.screen}: the 3D view drew again while capturing (${drawn}); retaking ${String(attempt + 1)}/${String(CAPTURE_ATTEMPTS)}`;
      console.log(`[撮影の撮り直し] ${note}`);
      info.annotations.push({ type: 'capture-retake', description: note });
      previous = { screen, detail };
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (diagnosticEnabled) {
      try {
        const report = await stopCaptureDiagnostic(page);
        const summary = captureDiagnosticSummary(names.screen, report);
        if (summary !== null) console.log(`[撮影診断] ${summary} (dialog image from: ${attempts.map(attempt => attempt.detailFrom).join(', ')})`);
        const prefix = names.screen.replace(/\.png$/u, '');
        if (failed) {
          for (const [index, attempt] of attempts.entries()) {
            const number = String(index + 1);
            await writeFile(info.outputPath(`${prefix}-diagnostic-${number}-screen.png`), attempt.screen, { flag: 'wx' });
            await writeFile(info.outputPath(`${prefix}-diagnostic-${number}-detail.png`), attempt.detail, { flag: 'wx' });
          }
        }
        await writeFile(info.outputPath(`${prefix}-diagnostic.json`), JSON.stringify({
          format: 'pointercad-capture-diagnostic/2', failed, attempts: attempts.map(attempt => ({
            settled: attempt.settled, afterScreen: attempt.afterScreen, afterDetail: attempt.afterDetail, detailFrom: attempt.detailFrom,
          })), ...report,
        }, null, 2), { flag: 'wx' });
      } catch (error) {
        console.error('[撮影診断] 記録または解除に失敗しました', error);
      }
    }
  }
}

/** Keep the whole working screen and a legible, unmodified dialog image together with their actual fixture. */
export async function captureManualDetail(page: Page, info: TestInfo, input: {
  readonly name: string;
  readonly dialog: Locator;
  readonly fixture: unknown;
  readonly script: URL;
}): Promise<void> {
  expect(input.name).toMatch(/^[a-z][a-z0-9-]*$/u);
  await input.dialog.waitFor({ state: 'visible' });
  await page.evaluate(async () => { await document.fonts.ready; });
  // 世代の帳簿(isComputing・世代)だけでなく、ドラッグ等に伴う個別の計算部呼び出し
  // (pendingWaiters)も含めて落ち着くまで待つ。個別 flow の waitForRecompute に頼らない。
  const before = await waitForSettledRecompute(page);
  expect(before.isComputing).toBe(false);
  expect(before.lastOutcome).toBe('success');
  expect(before.completedGeneration).toBe(before.requestedGeneration);
  expect(before.pendingWaiters).toBe(0);
  const screenState = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
    fontStatus: document.fonts.status, url: location.href,
    theme: document.documentElement.dataset.theme ?? null, uiScale: document.documentElement.dataset.uiScale ?? null }));
  // Only the registry's standard screen and tall-dialog exception may be captured (scripts/manual/captureRegistry.mjs).
  const viewportClass = classifyCaptureViewport([screenState.width, screenState.height]);
  // Electron never supplies manual images (see isElectronProject above), so it only records viewportClass
  // in the metadata below; Chromium (functional) and firefox keep failing on an unsupported screen size.
  if (!isElectronProject(info.project.name)) {
    expect(viewportClass !== 'needs-recapture', `Unsupported capture screen size ${screenState.width}x${screenState.height}`).toBe(true);
    // Dark theme, UI scale 100 %, device scale 1 and loaded fonts (plan P12-16; the same values the provenance bundle requires).
    expect({ theme: screenState.theme, uiScale: screenState.uiScale, deviceScaleFactor: screenState.deviceScaleFactor,
      fontStatus: screenState.fontStatus }, 'Manual captures use the fixed screen conditions').toEqual(CAPTURE_SCREEN_REQUIREMENTS);
  }
  const fixtureBytes = Buffer.from(JSON.stringify(input.fixture)), scriptBytes = await readFile(input.script);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const screenName = `${input.name}-screen.png`, detailName = `${input.name}-detail.png`;
  const { viewportRender, controlDescriptions, screen, detail } = await captureStillImages(page, info, input.dialog,
    { screen: screenName, detail: detailName });
  const after = await readRecomputeStats(page);
  expect(after).toEqual(before);
  const fixtureName = `${input.name}-fixture.json`;
  await writeFile(info.outputPath(fixtureName), fixtureBytes, { flag: 'wx' });
  const metadata = {
    format: 'pointercad-manual-detail/1', releaseCertified: false,
    capturedAt: new Date().toISOString(),
    applicationBuildId: await resolveApplicationBuildId(),
    project: info.project.name, sourceTest: info.title,
    // sourceFileHash reads CRLF as LF, so the Windows (CRLF) and the CI (LF) checkout of one script record the
    // same value, as the registry and the adoption compare it (scripts/manual/captureRegistry.mjs, captureProvenance.mjs).
    script: relative(projectRoot, fileURLToPath(input.script)).split(sep).join('/'), scriptSha256: sourceFileHash(scriptBytes),
    fixture: { filename: fixtureName, sha256: hash(fixtureBytes) },
    screen: { filename: screenName, sha256: hash(screen) }, detail: { filename: detailName, sha256: hash(detail) },
    controlDescriptions,
    recompute: after, viewportRender, dialogBounds: await input.dialog.boundingBox(),
    screenState, viewportClass,
  };
  await writeFile(info.outputPath(`${input.name}-capture.json`), JSON.stringify(metadata, null, 2), { flag: 'wx' });
}
