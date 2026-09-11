/** 板金作成の既定値と履歴上の識別子。未確定のプレビューでも文書を変更しない。 */
import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { nextSolidId, nextSolidName } from '../part/createPartDocument.js';
import type { PartDocument, SketchFaceRef, SketchLineRef } from '../part/types.js';
import type { SheetBaseFeature, SheetFlangeFeature, SheetBendFeature, SheetReliefFeature, SheetMetalRule, SheetPanelBoundaryRef } from './types.js';

export function defaultSheetMetalRule(): SheetMetalRule {
  return { thickness: n(1), innerRadius: n(1), kFactor: n(0.4) };
}
export function createSheetBaseFeature(document: PartDocument, profile: SketchFaceRef, rule = defaultSheetMetalRule()): SheetBaseFeature {
  return { kind: 'sheetBase', id: nextSolidId(document, 'sheetBase'), name: nextSolidName(document, 'sheetBase'),
    suppressed: false, profile, holes: [], reversed: false, rule };
}
export function createSheetFlangeFeature(document: PartDocument, targetFeatureId: string, edges: readonly SheetPanelBoundaryRef[]): SheetFlangeFeature {
  return { kind: 'sheetFlange', id: nextSolidId(document, 'sheetFlange'), name: nextSolidName(document, 'sheetFlange'),
    suppressed: false, targetFeatureId, edges, length: n(20), angle: n(90), startOffset: n(0), endOffset: n(0),
    lengthBasis: 'tangent', rule: { innerRadius: null, kFactor: null }, profile: null };
}
export function createSheetBendFeature(document: PartDocument, targetFeatureId: string, panelId: string, line: SketchLineRef): SheetBendFeature {
  return { kind: 'sheetBend', id: nextSolidId(document, 'sheetBend'), name: nextSolidName(document, 'sheetBend'),
    suppressed: false, targetFeatureId, panelId, line, fixedSide: 'right', angle: n(90), rule: { innerRadius: null, kFactor: null } };
}
export function createSheetReliefFeature(document: PartDocument, targetFeatureId: string, boundary: SheetPanelBoundaryRef,
  rule: SheetMetalRule = defaultSheetMetalRule()): SheetReliefFeature {
  return { kind: 'sheetRelief', id: nextSolidId(document, 'sheetRelief'), name: nextSolidName(document, 'sheetRelief'),
    suppressed: false, targetFeatureId, boundary, position: n(0), width: rule.thickness,
    depth: n(rule.innerRadius.value + rule.thickness.value), shape: 'rectangle',
    seamConnectionIds: document.sheetUnfolds.find((item) => item.sourceFeatureId === targetFeatureId)?.seamConnectionIds ?? [] };
}
