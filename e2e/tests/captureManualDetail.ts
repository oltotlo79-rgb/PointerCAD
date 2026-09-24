import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { applicationInputDigest, classifyCaptureViewport } from '../../scripts/manual/captureRegistry.mjs';
import { readRecomputeStats } from './recompute.js';
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
  const before = await readRecomputeStats(page);
  expect(before.isComputing).toBe(false);
  expect(before.lastOutcome).toBe('success');
  expect(before.completedGeneration).toBe(before.requestedGeneration);
  const screenState = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
    fontStatus: document.fonts.status, url: location.href }));
  // Only the registry's standard screen and tall-dialog exception may be captured (scripts/manual/captureRegistry.mjs).
  const viewportClass = classifyCaptureViewport([screenState.width, screenState.height]);
  // Electron never supplies manual images (see isElectronProject above), so it only records viewportClass
  // in the metadata below; Chromium (functional) and firefox keep failing on an unsupported screen size.
  if (!isElectronProject(info.project.name)) {
    expect(viewportClass !== 'needs-recapture', `Unsupported capture screen size ${screenState.width}x${screenState.height}`).toBe(true);
  }
  // Reuse this already prepared, stable screen; do not add another operation or alter focus.
  // The whole screen includes the toolbar and property fields surrounding the photographed dialog.
  const controlDescriptions = await assertRenderedControlDescriptions(page.locator('body'));
  const fixtureBytes = Buffer.from(JSON.stringify(input.fixture)), scriptBytes = await readFile(input.script);
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const screenName = `${input.name}-screen.png`, detailName = `${input.name}-detail.png`;
  const screen = await page.screenshot({ path: info.outputPath(screenName), animations: 'disabled' });
  const detail = await input.dialog.screenshot({ path: info.outputPath(detailName), animations: 'disabled' });
  const after = await readRecomputeStats(page);
  expect(after).toEqual(before);
  const fixtureName = `${input.name}-fixture.json`;
  await writeFile(info.outputPath(fixtureName), fixtureBytes, { flag: 'wx' });
  const metadata = {
    format: 'pointercad-manual-detail/1', releaseCertified: false,
    capturedAt: new Date().toISOString(),
    applicationBuildId: await resolveApplicationBuildId(),
    project: info.project.name, sourceTest: info.title, scriptSha256: hash(scriptBytes),
    fixture: { filename: fixtureName, sha256: hash(fixtureBytes) },
    screen: { filename: screenName, sha256: hash(screen) }, detail: { filename: detailName, sha256: hash(detail) },
    controlDescriptions,
    recompute: after, dialogBounds: await input.dialog.boundingBox(),
    screenState, viewportClass,
  };
  await writeFile(info.outputPath(`${input.name}-capture.json`), JSON.stringify(metadata, null, 2), { flag: 'wx' });
}
