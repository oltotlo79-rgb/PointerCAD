import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { readDocumentBundle } from '../../packages/io/src/index.js';
import {
  assemblyMechanismOracleFile, ORACLE_PHASE_DEG, ORACLE_POSITIONS, ORACLE_START_DEG, ORACLE_TARGETS_DEG,
} from './assemblyMechanismOracleFixture.js';
import { readAssemblyStats, type AssemblyBrowserStats } from './assemblyTestSupport.js';
import { openTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

const DEG = Math.PI / 180;
type Vector = readonly [number, number, number];
const AXES: readonly Vector[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Quaternion is only an observed orientation. q and -q rotate the same independent world basis vectors. */
function worldAxis(rotation: readonly number[] | undefined, axis: Vector): Vector {
  expect(rotation).toHaveLength(4);
  const [x = NaN, y = NaN, z = NaN, w = NaN] = rotation ?? [];
  expect(Math.abs(Math.hypot(x, y, z, w) - 1)).toBeLessThanOrEqual(1e-9);
  const q: Vector = [x, y, z], t = cross(q, axis), u = cross(q, t);
  return [axis[0] + 2 * (w * t[0] + u[0]), axis[1] + 2 * (w * t[1] + u[1]), axis[2] + 2 * (w * t[2] + u[2])];
}
function expectedAxis(axis: Vector, jointDegrees: number): Vector {
  const c = Math.cos(jointDegrees * DEG), s = Math.sin(jointDegrees * DEG);
  return [c * axis[0] + s * axis[1], -s * axis[0] + c * axis[1], axis[2]];
}
function angleErrorDeg(a: Vector, b: Vector): number {
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) / DEG;
}
function observedAngle(rotation: readonly number[] | undefined, previous: number): number {
  const x = worldAxis(rotation, [1, 0, 0]);
  const principal = Math.atan2(-x[1], x[0]) / DEG;
  return principal + 360 * Math.round((previous - principal) / 360);
}
function expectPosition(actual: readonly number[] | undefined, expected: Vector, label: string): number {
  expect(actual, label).toHaveLength(3);
  const error = Math.hypot((actual?.[0] ?? NaN) - expected[0], (actual?.[1] ?? NaN) - expected[1], (actual?.[2] ?? NaN) - expected[2]);
  expect(error, label).toBeLessThanOrEqual(1e-6);
  return error;
}
function expectOrientation(rotation: readonly number[] | undefined, degrees: number, label: string): number {
  const error = Math.max(...AXES.map(axis => angleErrorDeg(worldAxis(rotation, axis), expectedAxis(axis, degrees))));
  expect(error, label).toBeLessThanOrEqual(1e-6);
  return error;
}
const history = (page: Page, name: string): Locator => page.getByRole('group', { name: '履歴' }).getByRole('button', { name, exact: true });
async function expectNoHistory(page: Page): Promise<void> {
  await expect(history(page, '元に戻す')).toBeDisabled();
  await expect(history(page, 'やり直す')).toBeDisabled();
}
async function selectDriver(page: Page): Promise<Locator> {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^ジョイント$/u }),
  });
  const row = section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__select').filter({
    has: page.locator('.pcad-tree__label', { hasText: /^drive-a$/u }),
  });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  return page.locator('.pcad-assembly-motion').getByRole('spinbutton', { name: '回転角', exact: true });
}
async function drive(page: Page, degrees: number): Promise<void> {
  const input = await selectDriver(page);
  await expect(input).toBeEnabled();
  await input.fill(String(degrees));
  await expect.poll(async () => (await readAssemblyStats(page)).jointValues
    .find(item => item.key === ['drive-a', 'angle'].join(String.fromCharCode(0)))?.value).toBeCloseTo(degrees, 8);
}
function components(stats: AssemblyBrowserStats): Map<string, AssemblyBrowserStats['components'][number]> {
  return new Map(stats.components.map(component => [component.id, component]));
}

/** Compare all authored inputs, embedded child documents and source parts, excluding only the envelope save clock. */
export async function expectAssemblyInputUnchanged(source: Uint8Array, saved: Uint8Array): Promise<void> {
  const before = await readDocumentBundle(source, 'assembly'), after = await readDocumentBundle(saved, 'assembly');
  expect(before.ok).toBe(true); expect(after.ok).toBe(true);
  if (!before.ok || !after.ok) throw new Error('The real assembly reader rejected a saved oracle file');
  expect(before.bundle.kind).toBe('assembly'); expect(after.bundle.kind).toBe('assembly');
  expect(after.bundle).toEqual(before.bundle);
}

/** Exact numeric UI input; no mouse quantization allowance is used for this oracle. */
export async function assemblyMechanismOracleFlow(page: Page, info: TestInfo, app: ElectronApplication | undefined, ratio: number): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = await assemblyMechanismOracleFile(ratio), path = info.outputPath('mechanism-oracle.pcada');
  await writeFile(path, source);
  await openSaveFlowFile(page, path, app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  const initial = await readAssemblyStats(page), written = components(initial);
  expect(initial.diagnosis?.converged).toBe(true);
  expect(initial.components.map(item => item.id).sort()).toEqual(Object.keys(ORACLE_POSITIONS).sort());
  let previousA = ORACLE_START_DEG, previousB = ratio * ORACLE_START_DEG + ORACLE_PHASE_DEG;
  const maximum = { angleDeg: 0, positionMm: 0, relationDeg: 0 };
  const check = (stats: AssemblyBrowserStats, target: number): void => {
    const shown = components(stats), b = ratio * target + ORACLE_PHASE_DEG;
    for (const [id, degrees] of [['a', target], ['b', b]] as const) {
      const item = shown.get(id);
      maximum.angleDeg = Math.max(maximum.angleDeg, expectOrientation(item?.displayed?.rotation, degrees, `${id} world basis`));
      const position = ORACLE_POSITIONS[id];
      if (position === undefined) throw new Error('Missing independent position');
      maximum.positionMm = Math.max(maximum.positionMm, expectPosition(item?.displayed?.position, position, `${id} world origin`));
    }
    const observedA = observedAngle(shown.get('a')?.displayed?.rotation, previousA);
    const observedB = observedAngle(shown.get('b')?.displayed?.rotation, previousB);
    expect(Math.abs(observedA - target), 'unwrapped driver world angle').toBeLessThanOrEqual(1e-6);
    expect(Math.abs(observedB - b), 'unwrapped follower world angle').toBeLessThanOrEqual(1e-6);
    const relation = Math.abs(observedB - ratio * observedA - ORACLE_PHASE_DEG);
    expect(relation, 'independent affine gear equation').toBeLessThanOrEqual(1e-6);
    maximum.relationDeg = Math.max(maximum.relationDeg, relation);
    previousA = observedA; previousB = observedB;
    for (const [id, original] of written) {
      expect(shown.get(id)?.resolved, `${id} authored placement`).toEqual(original.resolved);
      if (id !== 'a' && id !== 'b') expect(shown.get(id), `${id} unrelated component`).toEqual(original);
    }
  };
  check(initial, ORACLE_START_DEG);
  for (const target of ORACLE_TARGETS_DEG) {
    await drive(page, target);
    check(await readAssemblyStats(page), target);
    await expectNoHistory(page);
  }
  const saved = info.outputPath('mechanism-oracle-saved.pcada');
  await expectAssemblyInputUnchanged(source, await saveFlowFile(page, saved, app));
  await openSaveFlowFile(page, saved, app);
  const reopened = await readAssemblyStats(page);
  expect(reopened.jointValues).toEqual([]);
  expect(reopened.components).toEqual(initial.components);
  await expectNoHistory(page);
  expect(errors).toEqual([]);
  await info.attach('independent-world-oracle', { body: JSON.stringify({ ratio, phaseDeg: ORACLE_PHASE_DEG,
    targetsDeg: ORACLE_TARGETS_DEG, maximum }), contentType: 'application/json' });
}

/** Invalid persisted inputs go through the real file picker/desktop open target and the actual reader. */
export async function assemblyMechanismRefusalFlow(page: Page, info: TestInfo, app: ElectronApplication | undefined): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = await assemblyMechanismOracleFile(-2), healthy = info.outputPath('mechanism-healthy.pcada');
  await writeFile(healthy, source);
  await openSaveFlowFile(page, healthy, app);
  let target = 181;
  await drive(page, target);
  for (const negative of ['contradictory-phase', 'missing-reference'] as const) {
    const bytes = await assemblyMechanismOracleFile(-2, negative);
    const parsed = await readDocumentBundle(bytes, 'assembly');
    expect(parsed.ok, `${negative} must actually be invalid`).toBe(false);
    if (parsed.ok) throw new Error('Negative fixture was unexpectedly accepted');
    expect(parsed.error.code).toBe('invalidField');
    const path = info.outputPath(`${negative}.pcada`), before = await readAssemblyStats(page);
    await writeFile(path, bytes);
    await expectNoHistory(page);
    if (app !== undefined) await openTarget(app, path);
    const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
    await fileAction(page, '開く').click();
    if (chooser !== null) await (await chooser).setFiles(path);
    await expect(page.locator('.pcad-statusbar__text')).toHaveText('ファイルが壊れているため開けませんでした。');
    expect(await readAssemblyStats(page), `${negative}: document, displayed poses and motion unchanged`).toEqual(before);
    await expectNoHistory(page);
    // Save after refusal checks the entire original document, not just displayed positions.
    await expectAssemblyInputUnchanged(source, await saveFlowFile(page, info.outputPath(`${negative}-unchanged.pcada`), app));
    target = target === 181 ? 179 : 181;
    await drive(page, target);
    const shown = components(await readAssemblyStats(page));
    expectOrientation(shown.get('a')?.displayed?.rotation, target, 'healthy driver after refusal');
    expectOrientation(shown.get('b')?.displayed?.rotation, -2 * target + ORACLE_PHASE_DEG, 'healthy follower after refusal');
    await expectNoHistory(page);
  }
  expect(errors).toEqual([]);
}
