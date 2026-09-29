import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { applicationInputDigest, CAPTURE_SCREEN_REQUIREMENTS, classifyCaptureViewport } from '../../scripts/manual/captureRegistry.mjs';
import { sourceFileHash } from '../../scripts/release/desktopFileInventory.mjs';
import { readRecomputeStats, waitForSettledRecompute } from './recompute.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

/**
 * How many times in all one pair of images may be taken when the 3D view drew again while it was being taken.
 * CI run 36506536360 (commit eae0101, the first run with the check below): 11 captures on Linux (1 Chromium
 * sheet-profile, 10 real Electron) saw 1-2 more finished drawings between the settled read and the end of the
 * capture, while the same specs never did on Windows (runs 20260929-112131 / -115159). Such a pair is never
 * kept: it is taken again once the view has settled again, and a view that keeps drawing still fails.
 */
const CAPTURE_ATTEMPTS = 3;

/** The screen and dialog images, taken while the 3D view (if any) finished no drawing at all. */
async function captureStillImages(page: Page, info: TestInfo, dialog: Locator, names: { readonly screen: string; readonly detail: string }) {
  const readRenders = () => page.evaluate(() => window.pcadViewportRenderStats?.().completedRenders);
  for (let attempt = 1; ; attempt += 1) {
    const viewportRender = await settledViewportRender(page);
    // Reuse this already prepared, stable screen; do not add another operation or alter focus.
    // The whole screen includes the toolbar and property fields surrounding the photographed dialog.
    const controlDescriptions = await assertRenderedControlDescriptions(page.locator('body'));
    const screen = await page.screenshot({ path: info.outputPath(names.screen), animations: 'disabled' });
    const afterScreen = viewportRender === null ? null : await readRenders();
    const detail = await dialog.screenshot({ path: info.outputPath(names.detail), animations: 'disabled' });
    const images = { viewportRender, controlDescriptions, screen, detail };
    if (viewportRender === null) return images;
    const afterDetail = await readRenders();
    const settled = viewportRender.completedRenders;
    if (afterScreen === settled && afterDetail === settled) return images;
    // Only a view that is still there and drew more is taken again; a vanished view or a lower count fails at once.
    const drewAgain = typeof afterScreen === 'number' && typeof afterDetail === 'number' && afterScreen >= settled && afterDetail >= afterScreen;
    const drawn = `settled ${String(settled)}, after the screen image ${String(afterScreen)}, after the dialog image ${String(afterDetail)}`;
    if (!drewAgain || attempt >= CAPTURE_ATTEMPTS) {
      expect({ afterScreen, afterDetail }, `The 3D view must not redraw while capturing (attempt ${String(attempt)}/${String(CAPTURE_ATTEMPTS)}: ${drawn})`)
        .toEqual({ afterScreen: settled, afterDetail: settled });
      return images;
    }
    // Recorded in the output and the report, never hidden: the retaken pair replaces this one.
    const note = `${names.screen}: the 3D view drew again while capturing (${drawn}); retaking ${String(attempt + 1)}/${String(CAPTURE_ATTEMPTS)}`;
    console.log(`[撮影の撮り直し] ${note}`);
    info.annotations.push({ type: 'capture-retake', description: note });
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
