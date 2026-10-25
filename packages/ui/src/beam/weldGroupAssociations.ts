import { filletWeldSegmentOptions, partKeyOf, weldPlacementFingerprint, weldSegmentsOf, type AssemblyDocument } from '@pointercad/model';
import type { CadWeldLayer } from '@pointercad/model/beam-analysis';

/** Keep the original CAD group's identity domain; numerical/CAD review still verifies its physical validity. */
export function weldGroupBeadIds(document: AssemblyDocument, beadId: string): ReadonlySet<string> {
  if (beadId === '') return new Set();
  const bead = document.components.find(component => component.id === beadId);
  const options = bead?.source.kind === 'standardPart' && bead.source.catalog === 'filletWeld'
    ? filletWeldSegmentOptions(bead.source.options) : null;
  const group = options === null ? undefined : weldSegmentsOf(document).get(options.weldId);
  return new Set(group === undefined ? [beadId] : group.map(component => component.id));
}

/** Selecting a physical interval associates its entire group in one cancellable session edit. */
export function selectWeldGroup(document: AssemblyDocument, rows: readonly CadWeldLayer[], rowId: string,
  beadId: string, newId: () => string): readonly CadWeldLayer[] | null {
  const selected = rows.find(row => row.id === rowId);
  const bead = document.components.find(component => component.id === beadId);
  if (selected === undefined || bead === undefined || bead.source.kind !== 'standardPart' || bead.source.catalog !== 'filletWeld') return null;
  const nextIds = weldGroupBeadIds(document, beadId), previousIds = weldGroupBeadIds(document, selected.beadComponentId);
  const retained = rows.filter(row => row.id !== rowId && !previousIds.has(row.beadComponentId) && !nextIds.has(row.beadComponentId));
  if (retained.length+nextIds.size > 64) return null;
  const group = document.components.filter(component => nextIds.has(component.id));
  const replacements = group.map(component => {
    const previous = rows.find(row => row.beadComponentId === component.id);
    return { ...selected, id: previous?.id ?? (component.id === beadId ? selected.id : newId()),
      beadComponentId: component.id, expectedPartKey: partKeyOf(component.source),
      expectedPlacementKey: weldPlacementFingerprint(component.placement), expectedMaterialId: component.materialId ?? '' };
  });
  const insertion = rows.slice(0, rows.indexOf(selected)).filter(row => retained.includes(row)).length;
  return [...retained.slice(0, insertion), ...replacements, ...retained.slice(insertion)];
}

/** All intervals share the explicitly declared endpoint/material assumptions. */
export function updateWeldGroup(document: AssemblyDocument, rows: readonly CadWeldLayer[], rowId: string,
  change: (row: CadWeldLayer) => CadWeldLayer): readonly CadWeldLayer[] {
  const selected = rows.find(row => row.id === rowId);
  if (selected === undefined) return rows;
  const ids = weldGroupBeadIds(document, selected.beadComponentId);
  return rows.map(row => row.id === rowId || ids.has(row.beadComponentId) ? change(row) : row);
}
