import { writeFile } from 'node:fs/promises';
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { assemblyFlexibleMotionFile, FLEXIBLE_JOINT, FLEXIBLE_LEAF_Z, FLEXIBLE_TOP } from './assemblyFlexibleMotionFixture.js';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';

/*
 * EX12 flexible subassembly host step (task012 flexible-r2), only through visible controls. Contracts read in source:
 * - AssemblyTree.tsx renderRow: nested component rows are open by default inside `.pcad-tree__children--assembly-nested`;
 *   the row button `.pcad-tree__select` selects the row id (component ids joined by '/').
 * - AssemblyPropertyPanel (flexible-r2): a nested subassembly row shows the section 'サブアセンブリの中のジョイント'
 *   (assembly.subJoint.title) with one number field per child joint coordinate, named '<joint> 移動量'.
 * - The drive is transient motion state: no document edit (Undo stays disabled), not saved; the reopened file shows no
 *   drive. pcadAssemblyOccurrenceDrives (E2E-only, PointerCadApp flexible-r2) lists the shown drives with the child
 *   placements of that occurrence; a placement without an entry is drawn at its resolved placement.
 */
const SLIDE_MM = 25;
const SECTION = 'サブアセンブリの中のジョイント';
const FIELD = `${FLEXIBLE_JOINT} 移動量`;

interface OccurrenceDriveStats {
  readonly key: string;
  readonly path: readonly string[];
  readonly values: readonly { readonly key: string; readonly value: number }[];
  readonly placements: readonly { readonly id: string; readonly position: readonly number[]; readonly rotation: readonly number[] }[];
}

declare global {
  interface Window {
    pcadAssemblyOccurrenceDrives?: () => readonly OccurrenceDriveStats[];
  }
}

async function readOccurrenceDrives(page: Page): Promise<readonly OccurrenceDriveStats[]> {
  return page.evaluate(() => {
    const read = window.pcadAssemblyOccurrenceDrives;
    if (read === undefined) throw new Error('検査専用の口 pcadAssemblyOccurrenceDrives が見つかりません。');
    return read();
  });
}
const exactLabel = (page: Page, name: string): Locator => page.locator('.pcad-tree__label', { hasText: new RegExp(`^${name}$`, 'u') });
/** The nested row `inner` under the top-level row `outer` in the '部品' section of the tree. */
function nestedRow(page: Page, outer: string): Locator {
  const section = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: /^部品$/u }),
  });
  const top = section.locator(':scope > .pcad-tree__children > li').filter({ has: exactLabel(page, outer) });
  return top.locator('.pcad-tree__children--assembly-nested > li > .pcad-tree__row .pcad-tree__select')
    .filter({ has: exactLabel(page, 'inner') });
}
async function selectNested(page: Page, outer: string): Promise<Locator> {
  const row = nestedRow(page, outer);
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  const section = page.getByRole('region', { name: SECTION, exact: true });
  await expect(section).toHaveAttribute('data-occurrence-path', `${outer}/inner`);
  return section;
}
async function expectTopPlacements(page: Page): Promise<void> {
  const stats = await readAssemblyStats(page);
  expect(stats.components.map(component => component.name).sort()).toEqual(Object.keys(FLEXIBLE_TOP).sort());
  for (const component of stats.components) {
    expect(component.displayed?.position, component.name).toEqual([...(FLEXIBLE_TOP[component.name] ?? [])]);
    expect(component.displayed?.rotation, component.name).toEqual([0, 0, 0, 1]);
  }
}
const undoButton = (page: Page): Locator => page.getByRole('group', { name: '履歴' }).getByRole('button', { name: '元に戻す', exact: true });

export async function assemblyFlexibleMotionFlow(page: Page, info: TestInfo, app: ElectronApplication | undefined): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const source = info.outputPath('flexible-motion.pcada');
  await writeFile(source, await assemblyFlexibleMotionFile());
  await openSaveFlowFile(page, source, app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await expectTopPlacements(page);
  expect(await readOccurrenceDrives(page)).toEqual([]);
  await expect(undoButton(page)).toBeDisabled();

  // Drive the leaf slider inside outer-a/inner through the property field: only that placement's arm moves.
  const sectionA = await selectNested(page, 'outer-a');
  const fieldA = sectionA.getByRole('spinbutton', { name: FIELD, exact: true });
  await expect(fieldA).toHaveValue('');
  await expect(fieldA).toBeEnabled();
  await fieldA.fill(String(SLIDE_MM));
  await expect.poll(async () => (await readOccurrenceDrives(page)).map(drive => drive.path.join('/'))).toEqual(['outer-a/inner']);
  const [drive] = await readOccurrenceDrives(page);
  const at = (id: string): readonly number[] => drive?.placements.find(item => item.id === id)?.position ?? [];
  [0, 0, FLEXIBLE_LEAF_Z + SLIDE_MM].forEach((value, axis) => expect(at('leaf-arm')[axis], 'driven arm').toBeCloseTo(value, 9));
  [0, 0, FLEXIBLE_LEAF_Z].forEach((value, axis) => expect(at('leaf-base')[axis], 'fixed leaf base').toBeCloseTo(value, 9));
  expect(drive?.values.map(item => Math.round(item.value * 1e6) / 1e6)).toEqual([SLIDE_MM]);
  await expect(sectionA.getByRole('alert')).toHaveCount(0);
  // The parent placements, the sibling placement and the document are unchanged; no Undo step was made.
  await expectTopPlacements(page);
  await expect(undoButton(page)).toBeDisabled();
  const sectionB = await selectNested(page, 'outer-b');
  await expect(sectionB.getByRole('spinbutton', { name: FIELD, exact: true })).toHaveValue('');
  expect((await readOccurrenceDrives(page)).map(item => item.path.join('/'))).toEqual(['outer-a/inner']);
  // Back on outer-a the field still shows the driven value (the solved value, so compared numerically).
  const again = (await selectNested(page, 'outer-a')).getByRole('spinbutton', { name: FIELD, exact: true });
  expect(Number(await again.inputValue())).toBeCloseTo(SLIDE_MM, 6);

  // Save and reopen: the drive is not saved, both placements show their written positions again.
  const saved = info.outputPath('flexible-motion-saved.pcada');
  await saveFlowFile(page, saved, app);
  await openSaveFlowFile(page, saved, app);
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', 'assembly');
  await expectTopPlacements(page);
  expect(await readOccurrenceDrives(page)).toEqual([]);
  await expect((await selectNested(page, 'outer-a')).getByRole('spinbutton', { name: FIELD, exact: true })).toHaveValue('');
  expect(errors).toEqual([]);
}
