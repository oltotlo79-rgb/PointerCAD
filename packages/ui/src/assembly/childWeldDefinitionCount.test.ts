import { describe, expect, it } from 'vitest';
import {
  buildStandardPartFromSource, createAssemblyDocument, EMPTY_PART_LIBRARY, MAX_SUB_ASSEMBLY_DEPTH, resolveAssembly,
  type AssemblyComponent, type AssemblyDocument, type PartLibrary,
} from '@pointercad/model';
import { childOwnedWeldFixture, WELDED_CHILD_REF } from '../../../model/src/analysis/cadWeldLayerChildOwned.testSupport.js';
import { testPlacement } from '../../../model/src/analysis/beamInputs.testSupport.js';
import { childWeldDefinitionTarget, commitChildWeldDefinitionEdit, definitionPlacementCount } from './childWeldDefinitionEdit.js';
import { createFilletWeldEditDraft } from './filletWeldDraft.js';

const place = (id: string, assemblyRef: string, x = 0): AssemblyComponent => ({ id, name: id,
  source: { kind: 'subAssembly', assemblyRef }, placement: testPlacement([x, 0, 0]), fixed: false, visible: true, suppressed: false });

/** Root R1, R2 -> definition 'pair' (A1, A2) -> the welded child: 2 x 2 = 4 actual placements of the welded child. */
function nested(extra: ReadonlyMap<string, AssemblyDocument> = new Map()) {
  const f = childOwnedWeldFixture();
  const pair: AssemblyDocument = { ...createAssemblyDocument('pair'), components: [place('A1', WELDED_CHILD_REF), place('A2', WELDED_CHILD_REF, 200)] };
  const root: AssemblyDocument = { ...createAssemblyDocument('root'), components: [place('R1', 'pair'), place('R2', 'pair', 500)] };
  const library: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies: new Map<string, AssemblyDocument>([[WELDED_CHILD_REF, f.child], ['pair', pair], ...extra]) };
  const bead = f.beads[0]?.id;
  if (bead === undefined) throw new Error('fixture bead missing');
  return { f, root, library, bead };
}

/**
 * A straight chain root -> n1 -> ... with `levels` nested subassembly placements L1..Ln, the welded child being the
 * innermost definition. levels = 8 is the deepest tree resolveAssembly accepts (depth + 1 > MAX is refused).
 */
function chain(levels: number) {
  const f = childOwnedWeldFixture();
  const refs = Array.from({ length: levels }, (_, index) => index === levels - 1 ? WELDED_CHILD_REF : `n${String(index + 1)}`);
  const assemblies = new Map<string, AssemblyDocument>([[WELDED_CHILD_REF, f.child]]);
  for (let index = 1; index < levels; index += 1) {
    const owner = refs[index - 1], next = refs[index];
    if (owner === undefined || next === undefined) throw new Error('chain ref missing');
    assemblies.set(owner, { ...createAssemblyDocument(owner), components: [place(`L${String(index + 1)}`, next)] });
  }
  const first = refs[0];
  if (first === undefined) throw new Error('chain ref missing');
  const root: AssemblyDocument = { ...createAssemblyDocument('root'), components: [place('L1', first)] };
  const library: PartLibrary = { ...EMPTY_PART_LIBRARY, assemblies };
  const bead = f.beads[0]?.id;
  if (bead === undefined) throw new Error('fixture bead missing');
  const path = [...Array.from({ length: levels }, (_, index) => `L${String(index + 1)}`), bead];
  const depthRefused = resolveAssembly(root, { library, subAssemblies: assemblies, standardPart: buildStandardPartFromSource })
    .errors.some((error) => error.code === 'subAssemblyDepth');
  return { root, library, path, depthRefused };
}

describe('affected placements of a shared child definition are the actual reachable placement paths', () => {
  it('counts a repeated parent once per placement: 2 x 2 = 4', () => {
    const { root, library, bead } = nested();
    expect(definitionPlacementCount(root, library, WELDED_CHILD_REF)).toBe(4);
    const target = childWeldDefinitionTarget(root, library, ['R1', 'A1', bead]);
    expect('refusal' in target ? target.refusal : target.affectedPlacements).toBe(4);
  });

  it('excludes a library definition the root never reaches', () => {
    const unused: AssemblyDocument = { ...createAssemblyDocument('unused'), components: [place('U1', WELDED_CHILD_REF)] };
    const { root, library } = nested(new Map([['unused', unused]]));
    expect(definitionPlacementCount(root, library, WELDED_CHILD_REF)).toBe(4);
  });

  it('counts suppressed placements, which still reference the shared definition', () => {
    const { root, library } = nested();
    const suppressed = { ...root, components: root.components.map((row) => row.id === 'R2' ? { ...row, suppressed: true } : row) };
    expect(definitionPlacementCount(suppressed, library, WELDED_CHILD_REF)).toBe(4);
  });

  it('refuses a cyclic or missing reachable definition instead of guessing a count', () => {
    const { root, library, bead } = nested();
    const loop: AssemblyDocument = { ...createAssemblyDocument('loop'), components: [place('L1', 'loop')] };
    const cyclicRoot = { ...root, components: [...root.components, place('L0', 'loop')] };
    const cyclicLibrary: PartLibrary = { ...library, assemblies: new Map<string, AssemblyDocument>([...(library.assemblies ?? []), ['loop', loop]]) };
    expect(definitionPlacementCount(cyclicRoot, cyclicLibrary, WELDED_CHILD_REF)).toBeNull();
    const cyclicTarget = childWeldDefinitionTarget(cyclicRoot, cyclicLibrary, ['R1', 'A1', bead]);
    expect('refusal' in cyclicTarget ? cyclicTarget.refusal : null).toBe('definitionTreeInvalid');
    const missingRoot = { ...root, components: [...root.components, place('M0', 'absent')] };
    expect(definitionPlacementCount(missingRoot, library, WELDED_CHILD_REF)).toBeNull();
  });

  it('a placement added after the confirmation changes the count and invalidates the confirmed scope', () => {
    const { f, root, library, bead } = nested();
    const target = childWeldDefinitionTarget(root, library, ['R1', 'A1', bead]);
    if ('refusal' in target) throw new Error('target refused: ' + target.refusal);
    const draft = createFilletWeldEditDraft('document', f.child, target.weldId);
    if (draft === null) throw new Error('edit draft missing');
    const grown = { ...root, components: [...root.components, place('R3', 'pair', 900)] };
    expect(definitionPlacementCount(grown, library, WELDED_CHILD_REF)).toBe(6);
    const result = commitChildWeldDefinitionEdit(grown, library, target, draft,
      { scope: 'definition', assemblyRef: WELDED_CHILD_REF, affectedPlacements: 4 }, () => null);
    expect(result.ok ? 'committed' : result.reason).toBe('confirmationRequired');
  });

  it('accepts exactly MAX_SUB_ASSEMBLY_DEPTH nested levels, the same boundary resolveAssembly accepts', () => {
    expect(MAX_SUB_ASSEMBLY_DEPTH).toBe(8);
    const { root, library, path, depthRefused } = chain(8);
    expect(depthRefused).toBe(false);
    expect(definitionPlacementCount(root, library, WELDED_CHILD_REF)).toBe(1);
    const target = childWeldDefinitionTarget(root, library, path);
    expect('refusal' in target ? target.refusal : target.affectedPlacements).toBe(1);
  });

  it('refuses a ninth nested level, the same boundary resolveAssembly refuses', () => {
    const { root, library, path, depthRefused } = chain(9);
    expect(depthRefused).toBe(true);
    expect(definitionPlacementCount(root, library, WELDED_CHILD_REF)).toBeNull();
    const target = childWeldDefinitionTarget(root, library, path);
    expect('refusal' in target ? target.refusal : null).toBe('definitionTreeInvalid');
  });
});
