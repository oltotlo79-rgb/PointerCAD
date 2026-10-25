/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import {
  CONSTRAINT_TOLERANCE, createEmptyPartDocument, replaceSketch, SKETCH_TOLERANCE_MM, type SketchDocument, type Vec3,
} from '../../packages/model/src/index.js';
import {
  CONNECTED_1000_FIXTURE_SHA256, CONNECTED_1000_POINT_COUNT, connected1000FixtureText, connected1000Original,
  connected1000PointId, connected1000Sketch,
} from '../../packages/model/src/sketch/constraints/connected1000Fixture.testSupport.js';
import type { SketchDragObservation } from '../../packages/ui/src/viewport/sketchDragObservation.js';
import { homeViewPagePoint } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { sketchTool } from './sketchFinishCaptureSupport.js';
import { uiMessage } from './uiMessages.js';

/*
 * EX-13 W01: the fixed connected 1000-point sketch opened from an ordinary .pcad file and one point dragged, only
 * through visible controls. The input is built by the same helper as sketchDragSession.connected1000.test.ts and
 * diagnose.test.ts (packages/model/src/sketch/constraints/connected1000Fixture.testSupport.ts) and its SHA-256 is
 * checked before it is written. Contracts read in the sources:
 * - Only the select tool grabs (attachSketchInteraction.ts startSketchDragInput). sketchDragSession.ts `begin` grabs the
 *   point under the pointer; `finish` commits the finished solve of the final target once, as one Undo step (setSketch),
 *   and the read-only E2E snapshot `pcadSketchDragStats` (sketchDragObservation.ts) records it as `lastCommitted`.
 * - After opening, the view is the home view (attachCameraControls starts at HOME_ORBIT); homeViewPagePoint projects it.
 * Independent expectation (no solve in the script): the 1997 distances make nondegenerate triangles on two anchors, a
 * rigid body whose rotation the vertical distance removes, so the only motions are the two translations. Grabbing point 0
 * at (0, 0) and releasing over (-20, -20) must store every point moved by one common translation t close to (-20, -20)
 * with every written length kept. The time from the release to the commit is recorded, never judged (EX-13 W07/W11).
 */
const DRAG_FROM: readonly [number, number, number] = [0, 0, 0];
const DRAG_TO: readonly [number, number, number] = [-20, -20, 0];
/** The pointer lands on CSS pixels, about 0.25 mm apart in the home view near the origin. */
const TARGET_TOLERANCE_MM = 1;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const undoButton = (page: Page) => page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true });

/** Spec-owned, read-only log of the page's pointerup event times (same clock as the drag snapshot). */
type PointerUpLogWindow = Window & { pcadConnected1000PointerUps?: number[] };
async function recordPointerUps(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host: PointerUpLogWindow = window;
    const log: number[] = [];
    host.pcadConnected1000PointerUps = log;
    window.addEventListener('pointerup', event => { log.push(event.timeStamp); }, { capture: true });
  });
}
async function lastPointerUp(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host: PointerUpLogWindow = window;
    const at = host.pcadConnected1000PointerUps?.at(-1);
    if (at === undefined) throw new Error('pointerup が記録されていません。');
    return at;
  });
}
async function dragStats(page: Page): Promise<SketchDragObservation> {
  return page.evaluate(() => {
    const read = window.pcadSketchDragStats;
    if (read === undefined) throw new Error('検査専用の口 pcadSketchDragStats が見つかりません（VITE_PCAD_E2E=1 の組み立て）。');
    return read();
  });
}

/** Closed-form check of the stored points: one common in-plane translation and every written length kept. */
function expectRigidTranslation(sketch: SketchDocument): readonly [number, number] {
  expect(sketch.features).toHaveLength(CONNECTED_1000_POINT_COUNT);
  const stored = new Map<string, Vec3>();
  for (const feature of sketch.features) {
    if (feature.kind !== 'point' || feature.at.mode !== 'absolute') throw new Error(`保存された点が想定と違います: ${feature.id}`);
    stored.set(feature.id, [feature.at.x.value, feature.at.y.value, feature.at.z.value]);
  }
  const at = (index: number): Vec3 => {
    const point = stored.get(connected1000PointId(index));
    if (point === undefined) throw new Error(`保存された点がありません: ${connected1000PointId(index)}`);
    return point;
  };
  const translation = [at(0)[0] - connected1000Original(0)[0], at(0)[1] - connected1000Original(0)[1]] as const;
  let position = 0, length = 0, height = 0;
  for (let index = 0; index < CONNECTED_1000_POINT_COUNT; index += 1) {
    const actual = at(index), initial = connected1000Original(index);
    position = Math.max(position, Math.abs(actual[0] - initial[0] - translation[0]), Math.abs(actual[1] - initial[1] - translation[1]));
    height = Math.max(height, Math.abs(actual[2]));
    for (const anchor of index === 1 ? [0] : index >= 2 ? [0, 1] : []) {
      const center = at(anchor), initialCenter = connected1000Original(anchor);
      const written = Math.hypot(initial[0] - initialCenter[0], initial[1] - initialCenter[1]);
      length = Math.max(length, Math.abs(Math.hypot(actual[0] - center[0], actual[1] - center[1]) - written));
    }
  }
  length = Math.max(length, Math.abs(at(1)[1] - at(0)[1] - 6));
  expect(position, '共通の平行移動からの最大のずれ(mm)').toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
  expect(height, '作図面からの最大の高さ(mm)').toBe(0);
  expect(length, '書かれた長さ1,998本の最大の残差(mm)').toBeLessThanOrEqual(CONSTRAINT_TOLERANCE);
  return translation;
}

export async function sketchConnected1000Flow(page: Page, info: TestInfo, app: ElectronApplication | undefined): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  // 1. The fixed input, checked by its SHA-256, written as an ordinary .pcad file.
  const empty = createEmptyPartDocument();
  const part = replaceSketch(empty, connected1000Sketch(empty.sketches[0]));
  const written = part.sketches[0], writtenConstraints = written.constraints ?? [];
  expect(sha256(connected1000FixtureText(written.features, writtenConstraints))).toBe(CONNECTED_1000_FIXTURE_SHA256);
  const source = info.outputPath('sketch-connected-1000.pcad');
  await writeFile(source, writePcadFile(part));

  // 2. Open it through the visible '開く': an opened document has no Undo step yet.
  await openSaveFlowFile(page, source, app);
  await expect(undoButton(page)).toBeDisabled();

  // 3. Grab point 0 with the select tool at its home-view position: the snapshot shows exactly one new grab.
  await sketchTool(page, '選択').click();
  const idle = await dragStats(page);
  expect(idle).toMatchObject({ active: false, solvePending: false, frameReserved: false, releasePending: false });
  await recordPointerUps(page);
  const from = await homeViewPagePoint(page, DRAG_FROM), to = await homeViewPagePoint(page, DRAG_TO);
  const commit = await beginRecompute(page);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await expect.poll(async () => (await dragStats(page)).active).toBe(true);
  const grabbed = await dragStats(page);
  expect(grabbed.session).toBe(idle.session + 1);

  // 4. Move and release over (-20, -20): the final target's solve is committed once and the document recomputed.
  await page.mouse.move(to[0], to[1], { steps: 10 });
  await page.mouse.up();
  await waitForRecompute(page, commit);
  const committed = await dragStats(page);
  expect(committed).toMatchObject({ session: grabbed.session, active: false, solvePending: false, frameReserved: false,
    releasePending: false, lastCancelled: idle.lastCancelled });
  const record = committed.lastCommitted;
  if (record === null) throw new Error('ドラッグが確定されていません。');
  expect(record.session).toBe(grabbed.session);
  const releasedAt = await lastPointerUp(page);
  expect(record.atMs).toBeGreaterThanOrEqual(releasedAt);
  const releaseToCommitMs = record.atMs - releasedAt;
  info.annotations.push({ type: 'EX-13 W01 pointerup-to-commit-ms (recorded, not judged)', description: String(releaseToCommitMs) });
  await expect(undoButton(page)).toBeEnabled();

  // 5. Save and read the stored sketch: the same 1998 constraints, every point moved by one translation near (-20, -20).
  const saved = readPcadFile(new Uint8Array(await saveFlowFile(page, info.outputPath('sketch-connected-1000-dragged.pcad'), app)));
  if (!saved.ok) throw new Error(JSON.stringify(saved.error));
  const sketch = saved.document.sketches[0];
  expect(sketch.constraints).toEqual(writtenConstraints);
  const translation = expectRigidTranslation(sketch);
  info.annotations.push({ type: 'EX-13 W01 stored translation (mm)', description: JSON.stringify(translation) });
  console.log(`[実測] EX-13 W01 1,000点のドラッグ: pointerup→確定 ${releaseToCommitMs.toFixed(1)}ms、`
    + `保存された平行移動 (${String(translation[0])}, ${String(translation[1])})mm（記録のみ。時間の判定は W07/W11）`);
  expect(Math.hypot(translation[0] - DRAG_TO[0], translation[1] - DRAG_TO[1])).toBeLessThanOrEqual(TARGET_TOLERANCE_MM);
  expect(errors).toEqual([]);
}
