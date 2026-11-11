import { describe, expect, it } from 'vitest';

import type { AssemblyComponent, AssemblyDocument } from '../assembly/types.js';
import { applyFilletWeld } from '../assembly/welding/applyFilletWeld.js';
import { plainTee, TEE_BODIES, teeRequest, WELD_TEST_REVISIONS } from '../assembly/welding/filletWeld.testSupport.js';
import { planFilletWeld, planFilletWeldEdit, weldSegmentsOf } from '../assembly/welding/planFilletWeld.js';
import { createDrawingDocument } from './createDrawingDocument.js';
import { linkableWeldIds, linkedWeldOf } from './linkedWeld.js';
import { embedDrawingSource } from './sourceLibrary.js';

function welded(): AssemblyDocument {
  const before = plainTee();
  const planned = planFilletWeld(before, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(before, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

/** Replace the first bead of weld-1 by `change(bead)`; the other beads stay as saved. */
function tamper(document: AssemblyDocument, change: (bead: AssemblyComponent) => AssemblyComponent): AssemblyDocument {
  const first = weldSegmentsOf(document).get('weld-1')?.[0];
  if (first === undefined) throw new Error('fixture');
  return { ...document, components: document.components.map((component) => component.id === first.id ? change(component) : component) };
}

describe('linked weld values use the same bead record validation as editing the weld', () => {
  it('refuses a bead whose generator revision no longer matches its options, exactly as planFilletWeldEdit does', () => {
    const damaged = tamper(welded(), (bead) => bead.source.kind === 'standardPart'
      ? { ...bead, source: { ...bead.source, generatorRevision: 'fillet-weld-0' } } : bead);
    expect(linkedWeldOf(damaged, 'weld-1')).toEqual({ kind: 'missing', reason: 'weldDamaged' });
    const edit = planFilletWeldEdit(damaged, { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8,
      segments: [{ start: 10, length: 20 }], materialId: 'aluminum' }, WELD_TEST_REVISIONS, TEE_BODIES);
    expect(edit.ok ? [] : edit.rejections.map((rejection) => rejection.code)).toEqual(['weldDamaged']);
  });

  it('refuses a bead with unreadable size, an invalid placement or different welded parts', () => {
    const changes: ((bead: AssemblyComponent) => AssemblyComponent)[] = [
      (bead) => bead.source.kind === 'standardPart' ? { ...bead, source: { ...bead.source, size: '6' } } : bead,
      (bead) => ({ ...bead, placement: { ...bead.placement, rotation: [0, 0, 0, 0] } }),
      (bead) => bead.source.kind === 'standardPart'
        ? { ...bead, source: { ...bead.source, options: { ...bead.source.options, weldParts: 'component-2,component-1' } } } : bead,
    ];
    for (const change of changes) {
      expect(linkedWeldOf(tamper(welded(), change), 'weld-1')).toEqual({ kind: 'missing', reason: 'weldDamaged' });
    }
  });

  it('offers the welds of the embedded assembly as link choices, and none without the embedded source', async () => {
    const embedded = await embedDrawingSource({ sources: [] }, { sourceKind: 'assembly', document: welded() }, '組立.pcadasm', '組立.pcadasm');
    const drawing = createDrawingDocument('図面', embedded.source);
    expect(linkableWeldIds(drawing, embedded.library)).toEqual(['weld-1']);
    expect(linkableWeldIds(drawing, { sources: [] })).toEqual([]);
  });
});
