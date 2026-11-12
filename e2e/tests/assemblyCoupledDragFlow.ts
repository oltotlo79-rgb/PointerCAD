import { writeFile } from 'node:fs/promises';
import { captureManualDetail } from './captureManualDetail.js';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { assemblyCoupledDragFile, DRAG_JOINTS, DRAG_TURN_LIMIT_DEG, DRAG_UNIT_ROTATION, DRAG_WRITTEN } from './assemblyCoupledDragFixture.js';
import { readAssemblyStats, type AssemblyBrowserStats } from './assemblyTestSupport.js';
import { homeViewPagePoint } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * EX12 coupled drag host flow (task014 drag-coverage-r1, successor of the drag-r1 flow), only through visible controls
 * on an ordinary file (assemblyCoupledDragFixture.ts). Contracts read in the sources:
 * - The gear is created with the form '段をまたぐ歯車' of the selected joint (AssemblyCrossLevelGearForm).
 * - The Home key on the viewport restores the home view (attachCameraControls 'Home' -> goHome, cameraMath HOME_ORBIT:
 *   target origin, distance 200, azimuth -45, elevation atan(sqrt(1/2)), 50 degree field of view); points are projected
 *   with the existing homeViewPagePoint (boltedJointTestSupport.ts), and every grab is checked to hit the intended body
 *   first (its tree row becomes 'pcad-tree__row--hovered', shell/AssemblyTree.tsx). No search over the screen.
 * - Viewport drag (attachAssemblyInteraction.ts): the drag plane passes through the grabbed component's origin with the
 *   view direction as normal; the target is that origin moved by the pointer's motion on the plane
 *   (viewport/dragComponent.ts componentDragTarget). A pointer over the plane point P therefore asks the component origin
 *   to P. The handle reaches every point (x, y, 0), so asking P with (P.x, P.y) = Q puts the handle at Q: the flow builds P
 *   from Q by hand (below) and the wheel turns to atan2(Q.y, Q.x).
 * - drag-r1: a drag that turns the coupled parent joint is joint motion (no document edit, no Undo step, not saved) and
 *   carries the coupled child, or is refused whole with the reason in '段をまたぐ連動の変更'; an ordinary drag of a free
 *   part stays one document edit with one Undo step.
 * Independent expectations: the arm of `unit` (turned +90 about x) turns by -2t about the leaf z axis, so its x axis in
 * the world is (cos 2t, 0, -sin 2t) and it stays at (0, 0, 100); the leaf limit is 40 degrees, so t = 30 asks -60 (refused)
 * and t = 12 asks -24 (accepted). The pointer is quantized to CSS pixels: the reached t is read back and compared with Q
 * within 1 degree; every relation is then checked on the reached t.
 */
const GEAR_FORM = '段をまたぐ歯車';
const GEAR_TARGET = 'unit : leaf-turn';
const REPAIRS = '段をまたぐ連動の変更';
const REFUSED_LIMIT = '動きを受け付けませんでした（段をまたぐ連動 cross-gear-1）。子のジョイントが連動の関係（比率またはカム）どおりの位置に届きません。';
const DEG = Math.PI / 180;
const HANDLE = DRAG_WRITTEN.handle ?? [50, 0, 0];
/** Unit vector from the target to the home camera (cameraMath HOME_ORBIT): the normal of every drag plane. */
const ELEVATION = Math.atan(Math.SQRT1_2), AZIMUTH = -Math.PI / 4;
const NORMAL: readonly [number, number, number] = [Math.cos(ELEVATION) * Math.cos(AZIMUTH), Math.cos(ELEVATION) * Math.sin(AZIMUTH), Math.sin(ELEVATION)];
/** The point P of the handle's drag plane (through its start origin) above Q = (x, y, 0). */
function onHandlePlane(q: readonly [number, number]): readonly [number, number, number] {
  const z = -((q[0] - HANDLE[0]) * NORMAL[0] + (q[1] - HANDLE[1]) * NORMAL[1]) / NORMAL[2] + HANDLE[2];
  return [q[0], q[1], z];
}
const onCircle = (degrees: number): readonly [number, number] => [50 * Math.cos(degrees * DEG), 50 * Math.sin(degrees * DEG)];

interface OccurrenceDriveStats {
  readonly path: readonly string[];
  readonly placements: readonly { readonly id: string; readonly position: readonly number[]; readonly rotation: readonly number[] }[];
}
/** The E2E-only window entry of flexible-r2, typed here without a second global declaration (the flexible flow has one). */
type OccurrenceDriveWindow = Window & { readonly pcadAssemblyOccurrenceDrives?: () => readonly OccurrenceDriveStats[] };
async function readOccurrenceDrives(page: Page): Promise<readonly OccurrenceDriveStats[]> {
  return page.evaluate(() => {
    const host: OccurrenceDriveWindow = window;
    const read = host.pcadAssemblyOccurrenceDrives;
    if (read === undefined) throw new Error('検査専用の口 pcadAssemblyOccurrenceDrives が見つかりません。');
    return read();
  });
}
function byName(stats: AssemblyBrowserStats): Map<string, AssemblyBrowserStats['components'][number]> {
  return new Map(stats.components.map(component => [component.name, component]));
}
function rotate(rotation: readonly number[] | undefined, v: readonly [number, number, number]): readonly number[] {
  const [x = Number.NaN, y = Number.NaN, z = Number.NaN, w = Number.NaN] = rotation ?? [];
  const cross = (a: readonly number[], b: readonly number[]): readonly number[] => [
    (a[1] ?? 0) * (b[2] ?? 0) - (a[2] ?? 0) * (b[1] ?? 0), (a[2] ?? 0) * (b[0] ?? 0) - (a[0] ?? 0) * (b[2] ?? 0),
    (a[0] ?? 0) * (b[1] ?? 0) - (a[1] ?? 0) * (b[0] ?? 0)];
  const t = cross([x, y, z], v), u = cross([x, y, z], t);
  return v.map((value, axis) => value + 2 * w * (t[axis] ?? 0) + 2 * (u[axis] ?? 0));
}
function zDegrees(rotation: readonly number[] | undefined): number {
  const [x = Number.NaN, y = Number.NaN, z = Number.NaN, w = Number.NaN] = rotation ?? [];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) / DEG;
}
function expectVector(actual: readonly number[] | undefined, expected: readonly number[], label: string): void {
  expected.forEach((value, axis) => expect(actual?.[axis], `${label} [${String(axis)}]`).toBeCloseTo(value, 6));
}
/** Every placement as written in the file, in the document (resolved) and, when `shown`, on screen (displayed). */
async function expectWritten(page: Page, shown: boolean): Promise<void> {
  const stats = byName(await readAssemblyStats(page));
  for (const [name, position] of Object.entries(DRAG_WRITTEN)) {
    expectVector(stats.get(name)?.resolved?.position, position, `${name} in the document`);
    if (shown) expectVector(stats.get(name)?.displayed?.position, position, `${name} on screen`);
  }
  expectVector(stats.get('unit')?.resolved?.rotation, DRAG_UNIT_ROTATION, 'unit turned +90 about x');
}

function treeSectionRows(page: Page, sectionName: string): Locator {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: sectionName }),
  });
  return section.locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
}
const exactLabel = (page: Page, name: string): Locator => page.locator('.pcad-tree__label', { hasText: new RegExp(`^${name}$`, 'u') });
async function selectJoint(page: Page, jointId: (typeof DRAG_JOINTS)[number]): Promise<void> {
  const row = treeSectionRows(page, 'ジョイント').nth(DRAG_JOINTS.indexOf(jointId)).locator('.pcad-tree__select');
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}
const historyButton = (page: Page, name: '元に戻す' | 'やり直す'): Locator =>
  page.getByRole('group', { name: '履歴' }).getByRole('button', { name, exact: true });
async function history(page: Page, name: '元に戻す' | 'やり直す'): Promise<void> {
  const token = await beginRecompute(page);
  await historyButton(page, name).click();
  await waitForRecompute(page, token);
}
async function homeView(page: Page): Promise<void> {
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Home');
}
/**
 * Failure-only diagnostic for a tree row that did not become hovered (CI run 43102593955, EX-18 Electron B/e: 30 s
 * without the class). Reads the topmost element at the pointer, the canvas box, every component row class, the mesh
 * ledger (host epoch changes and receipt validations), the assembly display owner, recompute and render statistics and,
 * on the desktop, the window state; attaches them and prints one `[hover診断]` line for the CI log. It only reads, and a
 * read failure never hides the original error. The judgement and its time limit stay with the caller.
 */
export async function attachHoverDiagnostics(page: Page, info: TestInfo, point: readonly [number, number],
  app: ElectronApplication | undefined): Promise<void> {
  let body: string;
  try {
    const viewport = await page.evaluate(([x, y]) => {
      const call = (name: string): unknown => {
        const read: unknown = Reflect.get(window, name);
        try { return typeof read === 'function' ? Reflect.apply(read, window, []) : 'unavailable'; }
        catch (error) { return `threw: ${String(error)}`; }
      };
      const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
      const tail = (value: unknown, count: number): unknown => Array.isArray(value) ? value.slice(-count) : value;
      const top = document.elementFromPoint(x, y);
      const box = document.querySelector('canvas.pcad-viewport__canvas')?.getBoundingClientRect();
      const ledger = call('pcadMeshLedgerDiagnostics');
      const host = field(ledger, 'host');
      return { point: [x, y], top: top === null ? null : `${top.tagName}.${top.getAttribute('class') ?? ''}`,
        canvas: box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height },
        hasFocus: document.hasFocus(), visibility: document.visibilityState,
        componentRows: Array.from(document.querySelectorAll('.pcad-tree__row[data-name-search-key^="component:"]'),
          row => `${row.getAttribute('data-name-search-key') ?? ''} ${row.getAttribute('class') ?? ''}`),
        meshLedger: typeof ledger === 'object' && ledger !== null ? { host: { epoch: field(host, 'epoch'),
          changes: tail(field(host, 'changes'), 24) }, validations: tail(field(ledger, 'validations'), 8) } : ledger,
        assemblyOwner: call('pcadViewportAssemblyOwner'), recompute: call('pcadRecomputeStats'),
        render: call('pcadViewportRenderStats') };
    }, point);
    const desktop = app === undefined ? null : await app.evaluate(({ BrowserWindow }) => {
      const shown = BrowserWindow.getAllWindows()[0];
      return shown === undefined ? null : { visible: shown.isVisible(), focused: shown.isFocused(),
        minimized: shown.isMinimized(), bounds: shown.getBounds() };
    });
    body = JSON.stringify({ viewport, desktop });
  } catch (error) {
    body = JSON.stringify({ unavailable: error instanceof Error ? error.message : String(error) });
  }
  await info.attach('hover-diagnostics', { body, contentType: 'application/json' }).catch(() => undefined);
  console.log(`[hover診断] ${body.slice(0, 4096)}`);
}

/** Waits for the hovered class exactly as before; only when it fails, the diagnostic above is added and the error rethrown. */
export async function expectHoveredRow(page: Page, info: TestInfo, row: Locator, point: readonly [number, number],
  app: ElectronApplication | undefined): Promise<void> {
  try { await expect(row).toHaveClass(/pcad-tree__row--hovered/u); }
  catch (error) { await attachHoverDiagnostics(page, info, point, app); throw error; }
}

/** The page point of a world point that must hit `name` first: the pointer is moved there and the tree row checked. */
async function grabPoint(page: Page, info: TestInfo, app: ElectronApplication | undefined, name: string,
  world: readonly [number, number, number]): Promise<readonly [number, number]> {
  const point = await homeViewPagePoint(page, world);
  await page.mouse.move(...point);
  const row = treeSectionRows(page, '部品').filter({ has: exactLabel(page, name) });
  await expectHoveredRow(page, info, row, point, app);
  return point;
}
/**
 * Diagnostic only (CI G09, wheel rotation 0 after the refused drag): the viewport's existing input observation
 * (ViewportCanvas readAssemblyOwner: the last two pointerdowns with gate, deferral and readiness) and the visible
 * refusal text, attached when the 12 degree drag did not turn the wheel. It reads only; the failure is rethrown.
 */
async function attachDragInputObservation(page: Page, info: TestInfo): Promise<void> {
  const owner = await page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportAssemblyOwner');
    const value: unknown = typeof read === 'function' ? read() : null;
    const field = (key: string): unknown => value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
    return { mateInputs: field('mateInputs') ?? null, assemblyReadyRefusal: field('assemblyReadyRefusal') ?? null,
      assemblyRefreshOutcome: field('assemblyRefreshOutcome') ?? null };
  });
  const repairs = await page.getByRole('region', { name: REPAIRS, exact: true }).allInnerTexts();
  await info.attach('coupled-drag-12-input', { body: JSON.stringify({ owner, repairs }, null, 2), contentType: 'application/json' });
}
async function dragTo(page: Page, from: readonly [number, number], to: readonly [number, number, number]): Promise<void> {
  const end = await homeViewPagePoint(page, to);
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(end[0], end[1], { steps: 12 });
  await page.mouse.up();
}

export async function assemblyCoupledDragFlow(page: Page, info: TestInfo, app: ElectronApplication | undefined): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = info.outputPath('coupled-drag.pcada');
  await writeFile(source, await assemblyCoupledDragFile());
  await openSaveFlowFile(page, source, app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  expect((await readAssemblyStats(page)).jointIds).toEqual([...DRAG_JOINTS]);
  await expectWritten(page, true);

  // Couple gear-drive to unit/leaf-turn through the visible form (ratio -2): one Undo step.
  await selectJoint(page, 'gear-drive');
  const form = page.getByRole('form', { name: GEAR_FORM, exact: true });
  await form.getByRole('combobox', { name: '子の組の回転ジョイント' }).selectOption({ label: GEAR_TARGET });
  const token = await beginRecompute(page);
  await form.getByRole('button', { name: '段をまたぐ連動を作る', exact: true }).click();
  await waitForRecompute(page, token);
  await expect(page.getByRole('form', { name: GEAR_FORM, exact: true })).toHaveCount(2);
  await homeView(page);
  await captureManualDetail(page, info, {
    name: 'assembly-cross-level-gear', dialog: form.first(),
    fixture: { selectedChild: GEAR_TARGET, joints: DRAG_JOINTS }, script: new URL(import.meta.url),
  });

  // 1. Pull the handle to 30 degrees: the leaf would have to turn -60, beyond its 40 degree limit. Refused whole: the
  //    reason is shown and nothing moved (no motion, no child drive, the document as written).
  expect(2 * 30).toBeGreaterThan(DRAG_TURN_LIMIT_DEG);
  await dragTo(page, await grabPoint(page, info, app, 'handle', [HANDLE[0], HANDLE[1], HANDLE[2]]), onHandlePlane(onCircle(30)));
  await expect(page.getByRole('region', { name: REPAIRS, exact: true }).getByRole('alert')).toHaveText(REFUSED_LIMIT);
  await expectWritten(page, true);
  expect(await readOccurrenceDrives(page)).toEqual([]);

  // 2. Pull it to 12 degrees (the leaf turns -24, inside the limit): the wheel turns and the coupled arm follows, as
  //    motion only.
  await dragTo(page, await grabPoint(page, info, app, 'handle', [HANDLE[0], HANDLE[1], HANDLE[2]]), onHandlePlane(onCircle(12)));
  try {
    await expect.poll(async () => Math.abs(zDegrees(byName(await readAssemblyStats(page)).get('wheel')?.displayed?.rotation)))
      .toBeGreaterThan(6);
  } catch (error) {
    await attachDragInputObservation(page, info).catch(() => undefined);
    throw error;
  }
  const shown = byName(await readAssemblyStats(page));
  const t = zDegrees(shown.get('wheel')?.displayed?.rotation);
  expect(Math.abs(t - 12)).toBeLessThan(1);
  const at = shown.get('handle')?.displayed?.position ?? [];
  const reach = Math.hypot(at[0] ?? Number.NaN, at[1] ?? Number.NaN);
  expectVector(at, [reach * Math.cos(t * DEG), reach * Math.sin(t * DEG), 0], 'handle on the turned wheel x axis');
  const arm = (await readOccurrenceDrives(page)).find(item => item.path.join('/') === 'unit')?.placements.find(item => item.id === 'leaf-arm');
  expectVector(rotate(arm?.rotation, [1, 0, 0]), [Math.cos(2 * t * DEG), 0, -Math.sin(2 * t * DEG)], 'coupled arm x axis (ratio -2, unit Rx 90)');
  expectVector(arm?.position, [0, 0, 100], 'coupled arm stays at the unit origin');
  // Joint motion, not an edit: the document still holds the written placements and one Undo removes the gear itself.
  await expectWritten(page, false);
  expectVector(shown.get('loose')?.displayed?.position, DRAG_WRITTEN.loose ?? [], 'loose not moved');
  await history(page, '元に戻す');
  await selectJoint(page, 'gear-drive');
  await expect(page.getByRole('form', { name: GEAR_FORM, exact: true })).toHaveCount(1);
  await history(page, 'やり直す');
  await selectJoint(page, 'gear-drive');
  await expect(page.getByRole('form', { name: GEAR_FORM, exact: true })).toHaveCount(2);

  // 3. An ordinary drag of the free part is still one document edit with one Undo step.
  await homeView(page);
  const loose = DRAG_WRITTEN.loose ?? [0, -60, 0];
  const edit = await beginRecompute(page);
  await dragTo(page, await grabPoint(page, info, app, 'loose', [loose[0], loose[1], loose[2]]), [loose[0] + 15, loose[1], loose[2]]);
  await waitForRecompute(page, edit);
  const moved = byName(await readAssemblyStats(page)).get('loose')?.resolved?.position ?? [];
  expect(Math.hypot((moved[0] ?? 0) - loose[0], (moved[1] ?? 0) - loose[1], (moved[2] ?? 0) - loose[2])).toBeGreaterThan(1);
  await history(page, '元に戻す');
  await expectWritten(page, true);

  // 4. Save and reopen: the gear persists, the drag motion does not.
  const saved = info.outputPath('coupled-drag-saved.pcada');
  await saveFlowFile(page, saved, app);
  await openSaveFlowFile(page, saved, app);
  await expectWritten(page, true);
  await selectJoint(page, 'gear-drive');
  await expect(page.getByRole('form', { name: GEAR_FORM, exact: true })).toHaveCount(2);
  expect(errors).toEqual([]);
}
