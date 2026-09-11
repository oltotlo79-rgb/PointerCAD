/** 書き出し中だけ実形状を専用所有先で保持する。プレビューのLRU残存には依存しない。 */
import { writeDxfDocument } from '@pointercad/io';
import { createSheetFlatSteps, recomputePart, recomputeSheetFlat, resolveSheetFlatOutline, sheetFlatBendLines, sheetFlatDxfEntities,
  type AssemblyKernelBridge, type ImportedShapeBytes, type PartDocument, type ResolvedSheetBody,
  type ResolvedSolidStep, type SheetUnfoldDefinition } from '@pointercad/model';

export type SheetOutputFormat = 'flatDxf' | 'flatStep' | 'foldedStep';
export interface SheetOutputRequest {
  readonly document: PartDocument; readonly sheet: ResolvedSheetBody; readonly definition: SheetUnfoldDefinition;
  readonly importedShapes: ImportedShapeBytes; readonly format: SheetOutputFormat; readonly requestId: string;
}
export interface SheetOutputFile { readonly fileName: string; readonly kind: 'dxf' | 'step'; readonly bytes: Uint8Array }
export type SheetOutputComputer = (request: SheetOutputRequest, shouldCancel: () => boolean) => Promise<SheetOutputFile>;

export function createSheetOutputComputer(bridge: AssemblyKernelBridge, detached: () => boolean): SheetOutputComputer {
  return async (request, shouldCancel) => {
    const partId = `sheet-export:${request.requestId}`, { document, definition, format } = request;
    const cancelled = () => detached() || shouldCancel();
    const ensureCurrent = () => { if (cancelled()) throw new Error('板金の書き出しを中止しました。'); };
    const baseName = `${document.name}-${format === 'foldedStep' ? '折曲げ' : '展開'}`;
    try {
      ensureCurrent();
      let steps: readonly ResolvedSolidStep[] = [];
      if (format === 'foldedStep') {
        const result = await recomputePart(document, bridge, { partId, generation: 1, importedShapes: request.importedShapes,
          shouldCancel: cancelled, onResolved: (resolved) => { steps = resolved.steps; } });
        ensureCurrent();
        if (result.errors.length > 0) throw new Error(result.errors[0].message);
        if (result.cancelled || !result.bodies.some((body) => body.featureId === definition.sourceFeatureId))
          throw new Error('書き出す板金の折曲げ形状がありません。');
      } else {
        const flat = await recomputeSheetFlat(request.sheet, definition, bridge, { partId, generation: 1, shouldCancel: cancelled });
        ensureCurrent();
        if (!flat.ok) throw new Error(flat.message);
        if (format === 'flatDxf') {
          const outline = await resolveSheetFlatOutline(bridge, flat.bodyKey, flat.geometry.thickness, cancelled);
          ensureCurrent();
          if (!outline.ok) throw new Error(outline.message);
          const bends = sheetFlatBendLines(flat.geometry); if (!bends.ok) throw new Error(bends.message);
          const entities = sheetFlatDxfEntities(outline.value, bends.value); if (!entities.ok) throw new Error(entities.message);
          const written = writeDxfDocument(entities.value);
          return { fileName: `${baseName}.dxf`, kind: 'dxf', bytes: new TextEncoder().encode(written.text) };
        }
        const flatSteps = createSheetFlatSteps(definition.sourceFeatureId, flat.geometry);
        if (!flatSteps.ok) throw new Error(flatSteps.message);
        steps = flatSteps.value;
      }
      ensureCurrent();
      const output = await bridge.exportShapes(steps, { partId, format: 'step', baseName, meshQuality: null, withColors: false, ascii: false,
        bodies: [{ featureId: definition.sourceFeatureId, name: document.name, color: null }] });
      ensureCurrent();
      if (output.kind === 'failed') throw new Error(output.message);
      if (output.kind !== 'files' || output.files.length !== 1) throw new Error('板金のSTEPファイルを作れませんでした。');
      return { ...output.files[0], kind: 'step' };
    } finally { await bridge.releasePart(partId); }
  };
}
