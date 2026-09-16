import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readRecomputeStats } from './recompute.js';
import { assertRenderedControlDescriptions } from './controlDescriptions.js';

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
    // Release packaging must additionally tie these artifacts to its complete application build manifest.
    applicationBuildId: null,
    project: info.project.name, sourceTest: info.title, scriptSha256: hash(scriptBytes),
    fixture: { filename: fixtureName, sha256: hash(fixtureBytes) },
    screen: { filename: screenName, sha256: hash(screen) }, detail: { filename: detailName, sha256: hash(detail) },
    controlDescriptions,
    recompute: after, dialogBounds: await input.dialog.boundingBox(),
    screenState: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio,
      fontStatus: document.fonts.status, url: location.href })),
  };
  await writeFile(info.outputPath(`${input.name}-capture.json`), JSON.stringify(metadata, null, 2), { flag: 'wx' });
}
