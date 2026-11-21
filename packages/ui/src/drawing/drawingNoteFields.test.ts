import type { Annotation, OutlinedText } from '@pointercad/drawing';
import {
  createAssemblyDocument, createDrawingDocument, createEmptyPartDocument, PART_EXAMPLES, type DrawingSourceLibrary, type Parameter,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { drawingNoteFields, drawingParameterRows } from './drawingNoteFields.js';
import { displayDrawingNote, drawingNoteBounds } from './noteDisplay.js';

const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'plate.pcad', path: '', contentHash: 'hash', importedAt: '' };
const parameters: Parameter[] = [
  { name: '板厚', value: { source: '6', value: 6, display: '6' }, unit: 'mm', description: '' },
  { name: '穴径', value: { source: '板厚 * 1.5', value: 9, display: '9' }, unit: 'mm', description: '' },
];
const library: DrawingSourceLibrary = { sources: [{ metadata: source, document: { ...createEmptyPartDocument(), parameters } }] };
const drawing = createDrawingDocument('部品図', source);
const note: Annotation = { id: 'note-1', kind: 'note', text: '板厚 {=板厚} mm、穴 φ{=穴径}、{=無い}、{{=板厚}', position: [20, 20],
  height: 3.5, layerId: 'layer-1' };

function outline(text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', missingCharacters: [], fillRule: 'nonzero', subpaths: [], metrics: { fontId: 'fixture', sizeMm,
    advanceMm: text.length * sizeMm, inkBounds: { left: 0, right: text.length * sizeMm, bottom: 0, top: sizeMm } } };
}

describe('普通の注記の係数の差し込み {=名前}', () => {
  it('図面の元の部品の係数の今の値に置き換え、解けない名前は「？」、逃がした括弧は原文', () => {
    expect(drawingNoteFields(drawing, library)(note.text)).toBe('板厚 6 mm、穴 φ9、？、{=板厚}');
  });

  it('元の部品が見つからない時は原文のまま', () => {
    expect(drawingNoteFields(drawing, { sources: [] })(note.text)).toBe(note.text);
    const other = { ...source, contentHash: 'other' };
    expect(drawingNoteFields(drawing, { sources: [{ metadata: other, document: createEmptyPartDocument() }] })(note.text)).toBe(note.text);
  });

  it('描く文字と、選ぶ時の囲みが同じ置き換え後の文字を使う', () => {
    const fields = drawingNoteFields(drawing, library);
    const shown = displayDrawingNote(note, outline, fields)?.texts?.map((text) => text.text).join('');
    expect(shown).toBe('板厚 6 mm、穴 φ9、？、{=板厚}');
    const bounds = drawingNoteBounds(note, outline, fields);
    expect(bounds?.right).toBe(20 + '板厚 6 mm、穴 φ9、？、{=板厚}'.length * 3.5);
  });
});

describe('係数の表の行(J-05c)', () => {
  const saddle = PART_EXAMPLES.find((example) => example.id === 'saddleSurface')?.create();
  if (saddle === undefined) throw new Error('鞍形の作例が無い');
  const unused: Parameter = { name: '幅', value: { source: '40', value: 40, display: '40' }, unit: 'mm', description: '板の幅' };
  const broken: Parameter = { name: '傾き', value: { source: '無い名前 * 2', value: 0, display: '0' }, unit: 'degree', description: '' };
  const part = { ...saddle, parameters: [...saddle.parameters, unused, broken] };
  const partLibrary: DrawingSourceLibrary = { sources: [{ metadata: source, document: part }] };

  it('「すべての係数」は元の部品の係数を表の並びのまま、値・単位・説明と並べ、解けない係数の値は「？」', () => {
    expect(drawingParameterRows(drawing, partLibrary, 'all')).toEqual([
      { name: 'a', value: '0.01', unit: t('parameterPanel.unit.none'), description: '' },
      { name: '幅', value: '40', unit: t('numericInput.unit.mm'), description: '板の幅' },
      { name: '傾き', value: '？', unit: t('numericInput.unit.degree'), description: '' },
    ]);
  });

  it('「関数の式で使う係数」は、関数の曲面の式が mathId と名前で指す係数だけ', () => {
    expect(drawingParameterRows(drawing, partLibrary, 'function')?.map((row) => row.name)).toEqual(['a']);
    const renamed = { ...part, parameters: part.parameters.map((item) => item.name === 'a' ? { ...item, name: 'b' } : item) };
    expect(drawingParameterRows(drawing, { sources: [{ metadata: source, document: renamed }] }, 'function')).toEqual([]);
  });

  it('組立の元では関数の式が無いので行は無く、元が見つからない時は null', () => {
    const assembly = { ...createAssemblyDocument('組図'), parameters: [unused] };
    const assemblyLibrary: DrawingSourceLibrary = { sources: [{ metadata: { ...source, sourceKind: 'assembly' }, document: assembly }] };
    expect(drawingParameterRows(drawing, assemblyLibrary, 'function')).toEqual([]);
    expect(drawingParameterRows(drawing, assemblyLibrary, 'all')?.map((row) => row.name)).toEqual(['幅']);
    expect(drawingParameterRows(drawing, { sources: [] }, 'all')).toBeNull();
  });
});
