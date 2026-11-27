import { describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import { serializeDrawing } from './drawingJson.js';
import { serializeDrawingTemplate } from './drawingTemplateJson.js';
import { writeDrawingTemplateFile } from './drawingTemplateFile.js';
import { pcadWriteDiagnosticOf, type PcadDrawingWriteCode } from './writeDiagnostic.js';

const savedAt = '2026-09-10T00:00:00.000Z';
const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: savedAt };

describe('Drawing write diagnostics', () => {
  it('図面とひな形の直接書き手は、以前のErrorの形で原因を伝える', () => {
    const drawing = createDrawingDocument('図面', source);
    const template = { name: 'Standard', sheet: drawing.sheet, layers: drawing.layers };
    const cases: readonly { write: () => unknown; code: PcadDrawingWriteCode }[] = [
      { write: () => serializeDrawing({ ...drawing, sheet: { ...drawing.sheet, scale: Infinity } }), code: 'drawingNonFinite' },
      { write: () => writeDrawingTemplateFile({ ...template, sheet: { ...template.sheet, scale: Infinity } }, savedAt), code: 'drawingNonFinite' },
      { write: () => serializeDrawingTemplate({ ...template, sheet: { ...template.sheet, scaleOptions: [1, 1] } }, savedAt),
        code: 'drawingTemplateInvalid' },
    ];
    for (const { write, code } of cases) {
      const refuse = () => {
        try { write(); } catch (error) { return error; }
        throw new Error('Drawing writer accepted an invalid input');
      };
      const error = refuse();
      if (!(error instanceof Error)) throw error;
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect(Object.keys(error)).toEqual([]);
      expect(pcadWriteDiagnosticOf(error)).toEqual({ code });
    }
  });
});
