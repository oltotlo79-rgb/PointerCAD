/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { expressionValueFromNumber as number } from '../../packages/expression/src/index.js';
import { readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { createKernelApi } from '../../packages/kernel/src/worker/kernelApi.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import {
  absoluteCoordinate, appendFeature, appendSolid, createDirectKernelBridge, createEmptyPartDocument,
  createPointFeature, createSubShapeReference, DEFAULT_WORK_PLANE_ID, nextFeatureId, nextFeatureName, recomputePart,
  replaceSketch, resolveSubShapeReference, type PartDocument, type SketchArcFeature, type SketchDocument,
  type SolidBody, type SolidFaceEntry, type SubShapeRef, type SurfaceFeature, type SurfaceOperation,
} from '../../packages/model/src/index.js';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { propertySection, propertyValue, solidRowBox } from './measurementCaptureSupport.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import {
  clickWorldPoint, commitPopover, fillFields, popover, popoverTitle, selectionKindLabel, treeRow,
} from './solidCaptureSupport.js';
import { waitForStartupHealth } from './startupHealth.js';

const CYLINDER_VOLUME = Math.PI * 10 ** 2 * 20;
const DRILLED_VOLUME = Math.PI * (10 ** 2 - 3 ** 2) * 20;
const SURFACE_SET = '円筒の側面と上下の端面';
const SURFACE_NAMES = ['縫う面1', '縫う面2', '縫う面3'] as const;
/** The tree badge of a body taken in by a later feature (view.json featureTree.consumed). */
const CONSUMED_BADGE = '統合済み';

function bodyOf(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const body = bodies.find(candidate => candidate.featureId === featureId);
  if (body === undefined) throw new Error(`Missing current body: ${featureId}`);
  return body;
}

/** Capture a real current face, with the same semantic-or-measured policy as the real-kernel unit fixture. */
function currentFace(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const semantic = createSubShapeReference(body, 'face', face.index);
  if (semantic !== null) return semantic;
  if (!body.isValid || body.faces.filter(candidate => candidate.index === face.index).length !== 1
    || (body.origins?.state === 'tracked' && !body.origins.fingerprintFallback?.some(entry =>
      entry.current.kind === 'face' && entry.current.index === face.index))) {
    throw new Error(`Cannot capture current face: ${body.featureId}/${String(face.index)}`);
  }
  const reference: SubShapeRef = { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
    kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid, axis: face.axis, radius: face.radius,
  } };
  const resolved = resolveSubShapeReference(body, reference);
  if (resolved.status !== 'matched' || resolved.match.reference.index !== face.index) {
    throw new Error('The real surface face did not resolve uniquely');
  }
  return resolved.match.reference;
}

/** A full circle of radius 10 mm parallel to XY at height z (the arc keeps the default work plane's orientation). */
function circleAt(sketch: SketchDocument, z: number): SketchArcFeature {
  return {
    id: nextFeatureId(sketch, 'arc'), name: nextFeatureName(sketch, 'arc'), planeId: DEFAULT_WORK_PLANE_ID, kind: 'arc',
    center: absoluteCoordinate(0, 0, z), radius: number(10), startAngle: number(0), endAngle: number(360),
    construction: false,
  };
}

/**
 * Ordinary saved input: a cylinder's side and both caps as three independent sketch-derived surfaces.
 * The side sweeps the lower circle by 20 mm and each cap is the planar face of its circle, so no solid body
 * overlaps the sewn result (the sewing itself takes the three surface bodies in). A saved selection set holds
 * the three faces, including the rear-facing lower cap, without depending on the view.
 * No sewn feature, hole or live application state is supplied by this fixture; the UI steps below make them.
 */
async function writeSurfaceInput(path: string): Promise<readonly SubShapeRef[]> {
  await loadOcctForNode();
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  try {
    const empty = createEmptyPartDocument();
    let sketch = empty.sketches[0];
    const lower = circleAt(sketch, 0);
    sketch = appendFeature(sketch, lower);
    const upper = circleAt(sketch, 20);
    sketch = appendFeature(sketch, upper);
    sketch = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(0, 0, 20)));
    const operations: readonly SurfaceOperation[] = [
      { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: [lower.id] }, distance: number(20), reversed: false },
      { kind: 'planar', profile: { sketchId: sketch.id, curveIds: [lower.id] } },
      { kind: 'planar', profile: { sketchId: sketch.id, curveIds: [upper.id] } },
    ];
    const surfaces: SurfaceFeature[] = operations.map((operation, index) => ({
      id: `surface-${String(index + 1)}`, name: `縫う面${String(index + 1)}`, kind: 'surface', suppressed: false, operation,
    }));
    let input: PartDocument = replaceSketch(empty, sketch);
    for (const surface of surfaces) input = appendSolid(input, surface);
    const result = await recomputePart(input, bridge);
    expect(result.errors).toEqual([]);
    const captured = surfaces.map(surface => {
      const body = bodyOf(result.bodies, surface.id);
      expect(body.bodyKind).toBe('shell');
      expect(body.faces).toHaveLength(1);
      return { surfaceKind: body.faces[0].surfaceKind, ref: currentFace(body, body.faces[0]) };
    });
    expect(captured.map(face => face.surfaceKind)).toEqual(['cylinder', 'plane', 'plane']);
    const faces = captured.map(face => face.ref);
    input = { ...input, selectionSets: [{ id: 'sew-faces', name: SURFACE_SET,
      members: faces.map(ref => ({ kind: 'face', ref })) }] };
    await writeFile(path, writePcadFile(input, { savedAt: '2026-10-25T00:00:00.000Z' }));
    return faces;
  } finally { bridge.dispose(); }
}

async function expectVolume(page: Page, expected: number): Promise<void> {
  // The property display rounds its value; the real-kernel unit tests enforce relative error <= 1e-9.
  await expect.poll(async () => {
    const cell = propertyValue(page, '体積');
    return await cell.count() === 0 ? Number.POSITIVE_INFINITY
      : Math.abs(Number.parseFloat(await cell.innerText()) - expected);
  }, { timeout: 60_000, message: `Volume ${String(expected)} mm³, display tolerance 0.01 mm³` }).toBeLessThanOrEqual(0.01);
}

/** Each input surface is shown as taken in (consumed) by the sewing, or as a free surface again. */
async function expectSurfacesConsumed(page: Page, consumed: boolean): Promise<void> {
  for (const name of SURFACE_NAMES) {
    await expect(treeRow(page, name)).toBeVisible();
    const badge = solidRowBox(page, name).locator('.pcad-tree__badge');
    if (consumed) await expect(badge).toHaveText(CONSUMED_BADGE);
    else await expect(badge).toHaveCount(0);
  }
}

export async function ex18SurfaceSewSolidFlow(
  page: Page, info: TestInfo, url = '/', app?: ElectronApplication,
): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (app === undefined) await disableFilePickers(page);
  await page.goto(url);
  await waitForStartupHealth(page, info);
  const inputPath = info.outputPath('ex18-three-surfaces.pcad');
  const originalFaces = await writeSurfaceInput(inputPath);
  await openSaveFlowFile(page, inputPath, app);
  await waitForSettledRecompute(page);

  // (1) The saved input holds only the three free surfaces, the hole centre and the three-face set.
  await expectSurfacesConsumed(page, false);
  await expect(treeRow(page, '点1')).toBeVisible();
  await expect(treeRow(page, '縫合1')).toHaveCount(0);
  await expect(treeRow(page, '穴1')).toHaveCount(0);
  const setPick = propertySection(page, '選択セット').locator('.pcad-constraint-row__pick').filter({ hasText: SURFACE_SET });
  await expect(setPick).toContainText('3 件');

  // (2) The set selects all three faces, including the rear lower cap, and enables sewing.
  await setPick.click();
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await expect(propertyValue(page, '選んだ数')).toHaveText('3');
  await openToolMenu(page, '作る');
  const sewButton = toolMenuPanel(page, '作る').getByRole('button', { name: '縫合', exact: true });
  await expect(sewButton).toBeEnabled();
  await sewButton.click();
  await expect(popoverTitle(page)).toHaveText('つなぐ');
  // Pressing the tool keeps the selected faces (the documented select-then-press order, solid-combine.md).
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await fillFields(page, ['0.0000001']);
  let token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
  await treeRow(page, '縫合1').click();
  await expectVolume(page, CYLINDER_VOLUME);
  await expectSurfacesConsumed(page, true);

  // (3) One undo removes the entire sewing operation and frees the three original surfaces; redo restores it.
  token = await beginRecompute(page);
  await page.keyboard.press('Control+z');
  await waitForRecompute(page, token);
  await expect(treeRow(page, '縫合1')).toHaveCount(0);
  await expectSurfacesConsumed(page, false);
  token = await beginRecompute(page);
  await page.keyboard.press('Control+y');
  await waitForRecompute(page, token);
  await treeRow(page, '縫合1').click();
  await expectVolume(page, CYLINDER_VOLUME);
  await expectSurfacesConsumed(page, true);

  // (4) The top-face click must reach the sewn result, so the hole names 縫合1 as its source.
  await openToolMenu(page, '加工');
  const holeButton = toolMenuPanel(page, '加工').getByRole('button', { name: '穴', exact: true });
  await expect(holeButton).toBeDisabled();
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, [4, 0, 20]);
  await treeRow(page, '点1').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await fillFields(page, ['6']);
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  token = await beginRecompute(page);
  await commitPopover(page);
  await waitForRecompute(page, token);
  await treeRow(page, '穴1').click();
  await expectVolume(page, DRILLED_VOLUME);
  await expect(propertyValue(page, '加工するもとの立体')).toHaveText('縫合1');

  // (5) The saved references are the original three faces; reopening keeps the source, volume and a clean tree.
  const savedPath = info.outputPath('ex18-surface-sew-hole.pcad');
  const saved = readPcadFile(await saveFlowFile(page, savedPath, app));
  if (!saved.ok) throw new Error(saved.error.message);
  const sew = saved.document.solids.find(feature => feature.kind === 'sew');
  if (sew?.kind !== 'sew') throw new Error('Saved sewing feature missing');
  expect(sew.faces).toEqual([]);
  expect(sew.surfaceFaces).toEqual(originalFaces);
  expect(saved.document.solids.find(feature => feature.kind === 'hole')).toMatchObject({ targetFeatureId: sew.id });
  await openSaveFlowFile(page, savedPath, app);
  await treeRow(page, '穴1').click();
  await expectVolume(page, DRILLED_VOLUME);
  await expect(propertyValue(page, '加工するもとの立体')).toHaveText('縫合1');
  await expectSurfacesConsumed(page, true);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('ex18-surface-sew-solid.png'), fullPage: true });
  expect(errors).toEqual([]);
}
