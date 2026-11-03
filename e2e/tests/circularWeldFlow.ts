/// <reference lib="dom" />
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test as baseTest, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { createDirectKernelBridge, recomputePart, buildStandardPartFromSource, readCircularFilletWeldSource,
  type AssemblyDocument } from '../../packages/model/src/index.js';
import { chooseToolMenuItem, installAssemblyFileGateway, openToolMenu, readAssemblyStats, resetAssemblyFileGateway, toolMenuPanel } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows, disableFilePickers, fileAction, goHome, placeQueuedPart, resolvedPoses } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { commitPopover, drawRectangle, extrudeFace, fillFields, makeFace, popover, popoverInputs, popoverTitle, treeRow } from './solidCaptureSupport.js';
import { waitForStartupReady } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

const title = (): string => uiMessage('assembly', 'assembly.circularFilletWeld.title');
const editTitle = (): string => uiMessage('assembly', 'assembly.circularFilletWeld.editTitle');
const dialog = (page: Page, editing = false) => page.getByRole('dialog', { name: editing ? editTitle() : title(), exact: true });
const field = (page: Page, name: string, editing = false) => dialog(page, editing).getByTestId('circular-weld-' + name);

/** Public authoring only: plate [-25,25]^2 x [-2,0], cylinder R10 x [0,10]. */
async function makeAssembly(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  if (app === undefined) { await disableFilePickers(page); await page.goto('/'); }
  else expect(page.url()).toBe('app://pointercad/index.html');
  await waitForStartupReady(page);
  await drawRectangle(page, ['-25', '-25'], ['50', '50'], '-2');
  await makeFace(page, ['線分1', '線分2', '線分3', '線分4']);
  await extrudeFace(page, '面1', '2');
  await waitForSettledRecompute(page);
  const plate = new Uint8Array(await saveFlowFile(page, info.outputPath('circular-plate.pcad'), app));
  await fileAction(page, '新規').click();
  await expect(page.locator('.pcad-viewport__empty-state')).toBeVisible();
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '円柱', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('円柱を置く');
  await fillFields(page, ['10', '10']);
  let token = await beginRecompute(page);
  await commitPopover(page); await waitForRecompute(page, token);
  if (await popover(page).count() > 0) await popoverInputs(page).first().press('Escape');
  await expect(treeRow(page, '円柱1')).toBeVisible();
  const cylinder = new Uint8Array(await saveFlowFile(page, info.outputPath('circular-cylinder.pcad'), app));
  token = await beginRecompute(page);
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '新しいアセンブリ');
  await waitForRecompute(page, token);
  await installAssemblyFileGateway(page, { parts: [{ fileName: '板.pcad', bytes: plate }, { fileName: '円柱.pcad', bytes: cylinder }] });
  await placeQueuedPart(page, ['', '', '']); await placeQueuedPart(page, ['', '', '']);
  await expect(componentRows(page)).toHaveCount(2); await goHome(page);
}

async function pickThree(page: Page, editing = false): Promise<void> {
  // Home view +X,-Y,+Z: plane clear of cylinder; lower ring away from seam; front curved wall.
  await expect(field(page, 'prompt', editing)).toHaveText(uiMessage('assembly', 'assembly.circularFilletWeld.pickPlane'));
  await clickWorldPointChecked(page, [18, -16, 0]);
  await expect(field(page, 'prompt', editing)).toHaveText(uiMessage('assembly', 'assembly.circularFilletWeld.pickEdge'));
  await clickWorldPointChecked(page, [10 * Math.SQRT1_2, -10 * Math.SQRT1_2, 0]);
  await expect(field(page, 'prompt', editing)).toHaveText(uiMessage('assembly', 'assembly.circularFilletWeld.pickCylinder'));
  await clickWorldPointChecked(page, [10 * Math.SQRT1_2, -10 * Math.SQRT1_2, 5]);
  await expect(field(page, 'prompt', editing)).toHaveText(uiMessage('assembly', 'assembly.circularFilletWeld.picked'));
}

async function saved(path: string): Promise<AssemblyDocument> {
  const result = await readDocumentBundle(await readFile(path), 'assembly');
  if (!result.ok || result.bundle.kind !== 'assembly') throw new Error('Circular assembly save did not decode');
  return result.bundle.document;
}
function beadOf(document: AssemblyDocument) {
  const rows = document.components.filter(c => c.source.kind === 'standardPart' && c.source.catalog === 'filletWeld');
  expect(rows).toHaveLength(1); const component = rows[0];
  if (component?.source.kind !== 'standardPart') throw new Error('Missing circular standard source');
  expect(component.source.generatorRevision).toBe('fillet-weld-5');
  const read = readCircularFilletWeldSource(component.source);
  if (read === null) throw new Error('Strict circular v5 reader refused actual saved source');
  expect(read.section).toEqual({ beadId: read.options.beadId, radialLegMm: 3, normalLegMm: 4, radialDirection: 1, normalDirection: 1 });
  const evidence = read.options.path.evidence, interval = read.options.path.intervals;
  expect(evidence.radiusMm).toBe(10); expect(interval).toHaveLength(1);
  expect(Math.abs(interval[0].toParameter - interval[0].fromParameter)).toBeCloseTo(Math.PI / 2, 12);
  const start = evidence.orientation === 1 ? evidence.parameterRange[0] : evidence.parameterRange[1];
  expect(interval[0].fromParameter).toBeCloseTo(start, 12);
  expect(read.options.parents.map(p => p.role)).toEqual(['plane', 'cylinder']);
  expect(read.options.parents.map(p => p.occurrencePath)).toEqual([[document.components[0].id], [document.components[1].id]]);
  expect(read.options.parents.map(p => p.ownerId)).toEqual([document.components[0].id, document.components[1].id]);
  expect(evidence.source.occurrencePath).toEqual([document.components[1].id]);
  expect(component.materialId).toBe('steel');
  return { component, source: component.source, read };
}

/** Fresh Node native evaluation of the ACTUAL UI-saved source, not UI Worker internals.
 * Same bridge/release discipline as circularFilletWeldGeometryKernel.test.ts.
 * A=6, centroid R=11, angle=pi/2 => V=33pi; whole circle would be132pi.
 */
async function inspectSavedNative(document: AssemblyDocument, info: TestInfo): Promise<void> {
  const { source, read } = beadOf(document), part = buildStandardPartFromSource(source);
  if (part === null) throw new Error('Saved circular source did not reconstruct');
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  try {
    const result = await recomputePart(part, bridge);
    expect(result.errors).toEqual([]); expect(result.bodies).toHaveLength(1);
    const body = result.bodies[0]; if (body === undefined) throw new Error('Missing real circular body');
    const rawPath = info.outputPath('circular-saved-native.json');
    await writeFile(rawPath, JSON.stringify({ source, section: read.section, volume: body.volume, vertices: body.vertices,
      valid: body.isValid, expectedVolume: 33 * Math.PI }), { flag: 'wx' });
    await info.attach('circular-saved-native', { path: rawPath, contentType: 'application/json' });
    expect(body.isValid).toBe(true); expect(Number.isFinite(body.volume)).toBe(true);
    expect(Math.abs(body.volume - 33 * Math.PI) / (33 * Math.PI)).toBeLessThan(1e-8);
    expect(body.mesh.positions.length).toBeGreaterThan(0);
    const sign = read.options.path.evidence.orientation;
    for (const point of [[10, 0, 0], [13, 0, 0], [10, 0, 4], [0, sign * 10, 0], [0, sign * 13, 0], [0, sign * 10, 4]]) {
      const distance = Math.min(...body.vertices.map(v => Math.hypot(...v.position.map((value, i) => value - point[i]))));
      expect(distance).toBeCloseTo(0, 4);
    }
  } finally { await bridge.releasePart(part.id); bridge.dispose(); }
}

async function history(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page); await page.getByRole('button', { name, exact: true }).click(); await waitForRecompute(page, token);
}
async function owner(page: Page): Promise<{ timelineIndex: number | null; documentVersion: number; assemblyIdentity: number }> {
  return page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportAssemblyOwner');
    const value: unknown = typeof read === 'function' ? read() : null;
    if (value === null || typeof value !== 'object') throw new Error('Current assembly/history observation unavailable');
    const timelineIndex: unknown = Reflect.get(value, 'timelineIndex');
    const documentVersion: unknown = Reflect.get(value, 'documentVersion');
    const assemblyIdentity: unknown = Reflect.get(value, 'assemblyIdentity');
    if ((timelineIndex !== null && typeof timelineIndex !== 'number')
      || typeof documentVersion !== 'number' || typeof assemblyIdentity !== 'number') {
      throw new Error('Current assembly/history observation unavailable');
    }
    return { timelineIndex, documentVersion, assemblyIdentity };
  });
}

export function registerCircularWeldTests(test: typeof baseTest, appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('円弧すみ肉溶接の公開操作', () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test.afterEach(async ({ page }, info) => {
      try {
        if (info.status !== info.expectedStatus && !page.isClosed()) {
          const observation = await page.evaluate(() => {
            const read: unknown = Reflect.get(window, 'pcadViewportAssemblyOwner');
            const value: unknown = typeof read === 'function' ? read() : null;
            return value === null || typeof value !== 'object' ? { available: false }
              : { available: true, mateInputs: Reflect.get(value, 'mateInputs'), ownership: Reflect.get(value, 'ownership') };
          });
          const path = info.outputPath('circular-pick-failure.json');
          await writeFile(path, JSON.stringify(observation), { flag: 'wx' });
          await info.attach('circular-pick-failure', { path, contentType: 'application/json' });
        }
      } finally { await resetAssemblyFileGateway(page); }
    });
    test('板と円柱から四分円ビードを作り、一括Undo/Redo、保存再開、再選択編集と取消を保つ', async ({ page }, info) => {
      const app = appForPage(page), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await makeAssembly(page, info, app);
      const before = await resolvedPoses(page);
      await chooseToolMenuItem(page, '組む', title()); await pickThree(page);
      for (const [name, source] of [['radialLeg', '3'], ['normalLeg', '4'], ['start', '0'], ['lengths', '5*pi']] as const) {
        await field(page, name).fill(source); await expect(field(page, name)).toHaveValue(source);
      }
      await field(page, 'radialDirection').selectOption('1'); await field(page, 'normalDirection').selectOption('1');
      await field(page, 'material').selectOption('steel');
      await expect(field(page, 'count')).toHaveText(`${uiMessage('assembly', 'assembly.filletWeld.segmentCount')} 1`);
      await expect(field(page, 'total')).toHaveText(`${uiMessage('assembly', 'assembly.filletWeld.totalLength')} 15.708`);
      await expect(field(page, 'volume')).toHaveText(`${uiMessage('assembly', 'assembly.circularFilletWeld.nominalVolume')} 103.673`);
      await expect(field(page, 'commit')).toBeEnabled();
      const token = await beginRecompute(page); await field(page, 'commit').click();
      await expect(dialog(page)).toHaveCount(0); await waitForRecompute(page, token);
      await expect(componentRows(page)).toHaveCount(3); const welded = await resolvedPoses(page);
      await history(page, '元に戻す'); await expect(componentRows(page)).toHaveCount(2); expect(await resolvedPoses(page)).toEqual(before);
      await history(page, 'やり直す'); await expect(componentRows(page)).toHaveCount(3); expect(await resolvedPoses(page)).toEqual(welded);
      await resetAssemblyFileGateway(page);
      const path = info.outputPath('circular-weld.pcada'); await saveFlowFile(page, path, app);
      const document = await saved(path), original = beadOf(document);
      await inspectSavedNative(document, info);
      await openSaveFlowFile(page, path, app); await expect(componentRows(page)).toHaveCount(3);
      expect(await resolvedPoses(page)).toEqual(welded);
      // Select the actual saved bead row; there is no inferred screen-coordinate retry.
      await componentRows(page).nth(2).click(); await expect(componentRows(page).nth(2)).toHaveAttribute('aria-pressed', 'true');
      const beforeCancel = await owner(page), stats = await readAssemblyStats(page);
      await chooseToolMenuItem(page, '組む', title());
      await expect(dialog(page, true)).toBeVisible(); await expect(field(page, 'edit-guide', true)).toBeVisible();
      await expect(field(page, 'commit', true)).toBeDisabled();
      await pickThree(page, true); await expect(field(page, 'commit', true)).toBeEnabled();
      await field(page, 'lengths', true).fill('4*pi'); await expect(field(page, 'lengths', true)).toHaveValue('4*pi');
      await field(page, 'cancel', true).click(); await expect(dialog(page, true)).toHaveCount(0);
      expect(await owner(page)).toEqual(beforeCancel); expect(await readAssemblyStats(page)).toEqual(stats);
      const afterPath = info.outputPath('circular-weld-after-cancel.pcada'); await saveFlowFile(page, afterPath, app);
      const after = await saved(afterPath); expect(after).toEqual(document);
      expect(beadOf(after).source).toEqual(original.source); expect(await resolvedPoses(page)).toEqual(welded);
      expect(errors).toEqual([]);
    });
  });
}
