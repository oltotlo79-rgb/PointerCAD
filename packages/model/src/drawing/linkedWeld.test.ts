import type { WeldSideSpec, WeldSymbol } from '@pointercad/drawing';
import { describe, expect, it } from 'vitest';

import type { AssemblyDocument } from '../assembly/types.js';
import { applyFilletWeld, removeFilletWeld } from '../assembly/welding/applyFilletWeld.js';
import { plainTee, TEE_BODIES, teeRequest, WELD_TEST_REVISIONS } from '../assembly/welding/filletWeld.testSupport.js';
import { planFilletWeld, planFilletWeldEdit, weldSegmentsOf } from '../assembly/welding/planFilletWeld.js';
import type { FilletWeldRequest } from '../assembly/welding/types.js';
import { createDrawingDocument } from './createDrawingDocument.js';
import { linkedWeldIssues, linkedWeldOf, linkedWeldSymbolValues, resolveLinkedWeld, type LinkedWeldResolution } from './linkedWeld.js';
import { embedDrawingSource } from './sourceLibrary.js';
import type { ResolvedWeldSymbol } from './welding.js';

/** The tee of filletWeld.testSupport.ts: contact edge 0..100, stations measured from the weld line origin. */
function welded(overrides: Partial<FilletWeldRequest> = {}): AssemblyDocument {
  const before = plainTee();
  const planned = planFilletWeld(before, teeRequest(overrides), WELD_TEST_REVISIONS, TEE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(before, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function linked(resolution: LinkedWeldResolution) {
  if (resolution.kind !== 'linked') throw new Error(JSON.stringify(resolution));
  return resolution.data;
}

const length = (value: number) => ({ expression: { source: String(value), value, display: String(value) }, unit: 'mm' as const });

/** Resolved values of one side in the order size, length, pitch, count (as resolveWeldSymbol returns them). */
type SideValues = readonly [number | null, number | null, number | null, number | null];
interface TestSide { readonly spec: WeldSideSpec; readonly values: SideValues }

function resolvedSymbol(sides: readonly TestSide[], weldId: string | null = 'weld-1'): ResolvedWeldSymbol {
  const symbol: WeldSymbol = { id: 'weld-symbol-1', system: 'B', target: { kind: 'point', viewId: 'view-1', paperPoint: [0, 0] },
    sides: sides.map((side) => side.spec), allAround: false, fieldWeld: false, tail: '', position: [10, 10], height: 3.5,
    layerId: 'layer-1', ...(weldId === null ? {} : { weldId }) };
  return { symbol, feature: null, issues: [], sides: sides.map(({ spec, values }) => ({ spec, sizeMm: values[0], lengthMm: values[1],
    pitchMm: values[2], count: values[3], rootGapMm: null, grooveDepthMm: null, grooveAngleDeg: null })) };
}

function fillet(values: SideValues, side: WeldSideSpec['side'] = 'arrow', sizeKind: 'leg' | 'throat' = 'leg'): TestSide {
  const spec: WeldSideSpec = { kind: 'fillet', side, contour: 'none', finish: 'none',
    ...(values[0] === null ? {} : { size: { kind: sizeKind, value: length(values[0]) } }) };
  return { spec, values };
}

describe('linked weld values are read from the model weld, never copied into the drawing', () => {
  it('lists every irregular bead with start, end, length, gaps, both legs and extent, and marks it not representable', () => {
    // teeRequest: legs 6 x 8, beads 10+20, 40+15, 70+25 on the 100 mm contact.
    const data = linked(linkedWeldOf(welded(), 'weld-1'));
    expect(data).toEqual({ weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8,
      beads: [{ start: 10, end: 30, length: 20 }, { start: 40, end: 55, length: 15 }, { start: 70, end: 95, length: 25 }],
      gaps: [10, 15], extent: { start: 10, end: 95 }, contactLength: 100, limitations: ['irregularBeads', 'unequalLegs'] });
    expect(linkedWeldSymbolValues(data)).toBeNull();
  });

  it('gives the symbol values of a regular intermittent weld and of a full-length continuous weld', () => {
    const regular = linked(linkedWeldOf(welded({ legOnSecond: 6, legOnFirst: 6,
      segments: [{ start: 0, length: 20 }, { start: 30, length: 20 }, { start: 60, length: 20 }] }), 'weld-1'));
    expect(regular.limitations).toEqual([]);
    expect(linkedWeldSymbolValues(regular)).toEqual({ legMm: 6, lengthMm: 20, pitchMm: 30, count: 3 });
    const full = linked(linkedWeldOf(welded({ legOnSecond: 5, legOnFirst: 5, segments: [{ start: 0, length: 100 }] }), 'weld-1'));
    expect(linkedWeldSymbolValues(full)).toEqual({ legMm: 5, lengthMm: null, pitchMm: null, count: null });
    const partial = linked(linkedWeldOf(welded({ legOnSecond: 5, legOnFirst: 5, segments: [{ start: 10, length: 50 }] }), 'weld-1'));
    expect(linkedWeldSymbolValues(partial)).toEqual({ legMm: 5, lengthMm: 50, pitchMm: null, count: null });
  });

  it('follows an edit of the weld and reports a removed or unknown weld as missing', () => {
    const before = welded();
    const edit = planFilletWeldEdit(before, { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 6,
      segments: [{ start: 0, length: 20 }, { start: 30, length: 20 }, { start: 60, length: 20 }], materialId: 'aluminum' },
    WELD_TEST_REVISIONS, TEE_BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    const applied = applyFilletWeld(before, edit.plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    expect(linkedWeldSymbolValues(linked(linkedWeldOf(applied.document, 'weld-1'))))
      .toEqual({ legMm: 6, lengthMm: 20, pitchMm: 30, count: 3 });
    const beads = (weldSegmentsOf(before).get('weld-1') ?? []).map((bead) => bead.id);
    expect(linkedWeldOf(removeFilletWeld(before, beads), 'weld-1')).toEqual({ kind: 'missing', reason: 'weldMissing' });
    expect(linkedWeldOf(before, 'weld-9')).toEqual({ kind: 'missing', reason: 'weldMissing' });
    expect(linkedWeldOf(before, '')).toEqual({ kind: 'missing', reason: 'weldMissing' });
  });

  it('reads only the assembly embedded with the same source identity as the drawing', async () => {
    const original = welded();
    const first = await embedDrawingSource({ sources: [] }, { sourceKind: 'assembly', document: original }, '組立.pcadasm', '組立.pcadasm');
    const drawing = createDrawingDocument('図面', first.source);
    expect(linked(resolveLinkedWeld(drawing, first.library, 'weld-1')).beads).toHaveLength(3);
    // A drawing whose embedded source is absent (or was replaced by another content hash) cannot check the weld.
    expect(resolveLinkedWeld(drawing, { sources: [] }, 'weld-1')).toEqual({ kind: 'missing', reason: 'sourceNotEmbedded' });
    const edited = welded({ segments: [{ start: 0, length: 100 }] });
    const second = await embedDrawingSource({ sources: [] }, { sourceKind: 'assembly', document: edited }, '組立.pcadasm', '組立.pcadasm');
    expect(resolveLinkedWeld(drawing, second.library, 'weld-1')).toEqual({ kind: 'missing', reason: 'sourceNotEmbedded' });
    // After the drawing takes the re-imported source, it reads the edited weld.
    const refreshed = createDrawingDocument('図面', second.source);
    expect(linked(resolveLinkedWeld(refreshed, second.library, 'weld-1')).beads).toEqual([{ start: 0, end: 100, length: 100 }]);
  });
});

describe('a linked symbol is resolved only when it states exactly the model weld', () => {
  const regular = (): LinkedWeldResolution => linkedWeldOf(welded({ legOnSecond: 6, legOnFirst: 6,
    segments: [{ start: 0, length: 20 }, { start: 30, length: 20 }, { start: 60, length: 20 }] }), 'weld-1');

  it('does not check an independent manual symbol', () => {
    const manual = resolvedSymbol([fillet([9, 99, null, null])], null);
    expect(manual.symbol).not.toHaveProperty('weldId');
    expect(linkedWeldIssues(manual, regular())).toEqual([]);
  });

  it('accepts the matching fillet values and refuses a different length, a second side or a throat size', () => {
    expect(linkedWeldIssues(resolvedSymbol([fillet([6, 20, 30, 3])]), regular())).toEqual([]);
    for (const sides of [[fillet([6, 25, 30, 3])], [fillet([6, 20, 30, 3]), fillet([6, 20, 30, 3], 'opposite')]]) {
      expect(linkedWeldIssues(resolvedSymbol(sides), regular()).map((issue) => issue.code)).toEqual(['linkedWeld']);
    }
    expect(linkedWeldIssues(resolvedSymbol([fillet([6, 20, 30, 3], 'arrow', 'throat')]), regular()).map((issue) => issue.code))
      .toEqual(['linkedWeld']);
  });

  it('keeps an irregular or unequal-leg weld unresolved with both reasons, and a missing weld unresolved', () => {
    const irregular = linkedWeldOf(welded(), 'weld-1');
    const issues = linkedWeldIssues(resolvedSymbol([fillet([6, 20, null, null])]), irregular);
    expect(issues.map((issue) => issue.code)).toEqual(['linkedWeld', 'linkedWeld']);
    expect(issues.map((issue) => issue.message).join(' ')).toContain('補足の一覧');
    const missing = linkedWeldIssues(resolvedSymbol([fillet([6, 20, 30, 3])]), { kind: 'missing', reason: 'weldMissing' });
    expect(missing).toHaveLength(1);
    expect(missing[0]?.message).toContain('見つかりません');
  });
});
