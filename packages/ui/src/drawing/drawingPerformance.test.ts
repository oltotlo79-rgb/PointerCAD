import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectWithinBudget } from '@pointercad/test-utils';
import { autoDimension, createFontStore, hatchArea, renderDrawing, toPdf, toSvg,
  type AutoDimensionPoint, type Dimension, type DrawingDocument, type DrawingView, type GeometricToleranceFrame,
  type Point2, type RenderDocument, type RenderPath, type RenderText } from '@pointercad/drawing';
import { createDrawingDocument, IDENTITY_PLACEMENT, resolveDrawingDimensions, resolveDrawingGdt,
  type SolidBody, type SolidEdgeEntry } from '@pointercad/model';
import { writeDrawingDxf } from '@pointercad/io';
import { displayDrawingGdt } from './gdtDisplay.js';

const fontPath = fileURLToPath(new URL('../../../../apps/web/public/fonts/NotoSansJP-Regular.otf', import.meta.url));
const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(fontPath)).buffer) });
const measurements: { label: string; elapsedMs: number; budgetMs: number }[] = [];
function budget(label: string, elapsedMs: number, budgetMs: number): void {
  measurements.push({ label, elapsedMs, budgetMs });
  console.log(`[実測] ${label}: ${elapsedMs.toFixed(3)}ms / ${budgetMs}ms`);
  expectWithinBudget(elapsedMs, budgetMs, label);
}
const source = { sourceRef: 'source', sourceKind: 'part' as const, fileName: 'dimensions.pcad', path: '', contentHash: '', importedAt: '' };
const view: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], scale: 1,
  direction: [0, 1, 0], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const edges: readonly SolidEdgeEntry[] = Array.from({ length: 100 }, (_, index) => ({ index, curveKind: 'line',
  length: 20 + index, midpoint: [(20 + index) / 2, 0, index], start: [0, 0, index], end: [20 + index, 0, index],
  axis: [1, 0, 0], radius: null, segmentOffset: index, segmentCount: 1 }));
const body: SolidBody = { featureId: 'solid', mesh: { positions: new Float32Array(), normals: new Float32Array(),
  indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
  volume: 0, isValid: true, bodyKind: 'solid', faces: [], edges, vertices: [], threadMarks: [] };
const dimensions: readonly Dimension[] = edges.map((edge) => ({ id: `dim-${edge.index}`, kind: 'length', measurement: 'trueDistance',
  targets: [{ kind: 'subShape', sourceRef: 'source', viewId: view.id, ref: { bodyFeatureId: body.featureId, index: edge.index,
    fingerprint: { kind: 'edge', curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis, radius: null } } }],
  placement: { commonNormalCoordinate: 20, textPosition: null }, origin: 'manual', reference: false, layerId: 'layer-4' }));
const document: DrawingDocument = { ...createDrawingDocument('性能検査', source), views: [view], dimensions };
const context = { modelCenter: [0, 0, 0] as const, instances: [{ sourceRef: 'source', bodyId: 'solid', body, placement: IDENTITY_PLACEMENT }] };
function outline(value: string, size: number) {
  const result = font.outline(value, size);
  if (result.status !== 'ready' || result.metrics === null) throw new Error('実字体の輪郭なし');
  return { ...result, metrics: result.metrics };
}
function text(value: string, x: number, y: number): RenderText {
  const result = outline(value, 3.5);
  return { kind: 'text', ownerId: value, layerId: 'layer-5', transform: [1, 0, 0, 1, 0, 0], clip: null,
    fill: '#000000', text: value, position: [x, y], angle: 0, anchor: 'start', baseline: 'alphabetic',
    outline: result.subpaths, metrics: result.metrics };
}
function outputSheet(): RenderDocument {
  const lines: RenderPath[] = Array.from({ length: 5000 }, (_, i) => ({ kind: 'path', ownerId: `line-${i}`, layerId: 'layer-1',
    transform: [1, 0, 0, 1, 0, 0], clip: null, fill: null, fillRule: 'nonzero', stroke: { color: '#000000', widthMm: 0.25, dashMm: [] },
    subpaths: [{ commands: [{ kind: 'M', to: [10 + i % 100, 10 + Math.floor(i / 100)] }, { kind: 'L', to: [110 + i % 100, 10 + Math.floor(i / 100)] }] }] }));
  const alphabet = [...'8日φ板0123456789'];
  return { widthMm: 420, heightMm: 297, primitives: [...lines,
    ...Array.from({ length: 500 }, (_, i) => text(alphabet[i % alphabet.length], 20 + i % 50 * 7, 100 + Math.floor(i / 50) * 10))] };
}
function point(id: string, x: number, y: number): AutoDimensionPoint {
  const modelPoint = [x, y, 0] as const, paperPoint: Point2 = [20 + x / 2, 20 + y / 2];
  return { id, modelPoint, paperPoint, target: { kind: 'point', viewId: 'front', modelPoint, paperPoint } };
}

describe('図面の測定・配置・出力の性能と決定性（P8-70/P9-20）', () => {
  beforeAll(async () => { expect(await font.load()).toBe('ready'); });
  afterAll(() => {
    const requested = process.env.POINTERCAD_DRAWING_QA_DIR;
    if (requested === undefined) return;
    const allowed = fileURLToPath(new URL('../../../../scratchpad/', import.meta.url)), directory = resolve(requested);
    const fromAllowed = relative(allowed, directory);
    if (isAbsolute(fromAllowed) || fromAllowed.startsWith('..')) throw new Error('図面の計測出力はscratchpad内に限定します');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'drawing-performance.json'), JSON.stringify(measurements, null, 2), { encoding: 'utf8', flag: 'wx' });
  });

  it('100本の異なる辺参照の寸法を16ms以内で再評価する', () => {
    const initial = resolveDrawingDimensions(document, context);
    const started = performance.now(), result = resolveDrawingDimensions(document, context), elapsed = performance.now() - started;
    expect(result).toEqual(initial); expect(result).toHaveLength(100);
    expect(result.every((item) => item.status === 'resolved')).toBe(true);
    budget('100寸法の再評価', elapsed, 16);
  });

  it('異なる16穴から50本の自動寸法を16ms以内で配置する', () => {
    const input = { viewId: 'front', direction: [0, 0, -1] as const, xDir: [1, 0, 0] as const, layerId: 'layer-4',
      boundary: [point('a', 0, 0), point('b', 700, 0), point('c', 700, 400), point('d', 0, 400)],
      circles: Array.from({ length: 16 }, (_, i) => ({ ...point(`hole-${i}`, 40 + i * 40, 30 + i * 20), radius: i + 1, full: true })),
      existing: [], measureText: (value: string) => outline(value, 3.5).metrics };
    const initial = autoDimension(input);
    const started = performance.now(), result = autoDimension(input), elapsed = performance.now() - started;
    expect(result).toEqual(initial); expect(result?.dimensions).toHaveLength(50); expect(result?.unresolvedOverlapIds).toEqual([]);
    budget('50自動寸法の配置', elapsed, 16);
  });

  it('200点・200mm径・3mm間隔のハッチを16ms以内で作る', () => {
    const loop = Array.from({ length: 200 }, (_, i): Point2 => [100 + 100 * Math.cos(i * Math.PI / 100), 100 + 100 * Math.sin(i * Math.PI / 100)]);
    const input = { loops: [loop], angleRad: Math.PI / 4, pitchMm: 3 };
    const started = performance.now(), result = hatchArea(input), elapsed = performance.now() - started;
    expect(result).toEqual(hatchArea(input)); expect(result.length).toBeGreaterThan(60);
    const length = result.reduce((sum, line) => sum + Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]), 0);
    expect(Math.abs(length - Math.PI * 10000 / 3) / (Math.PI * 10000 / 3)).toBeLessThan(0.01);
    budget('200点ハッチ', elapsed, 16);
  });

  it.each([['pdf', 2000], ['svg', 500], ['dxf', 500]] as const)('5000線・実字体500文字の%s出力を%dms以内で作る', (format, limit) => {
    const started = performance.now(), sheet = outputSheet();
    const output = () => format === 'pdf' ? toPdf(sheet) : format === 'svg' ? toSvg(sheet) : writeDrawingDxf(sheet, document.layers);
    const result = output(), elapsed = performance.now() - started;
    expect(result).toEqual(output()); expect(result).not.toBeNull();
    if (format === 'pdf') expect(result).toMatchObject({ ok: true });
    if (format === 'dxf') expect(result).toMatchObject({ skippedPrimitiveCount: 0 });
    budget(`5000線/500文字 ${format}`, elapsed, limit);
  });

  it('100公差の値変更・実形状解決・実字体配置・SVG描画を500ms以内で反映する', () => {
    const frames: GeometricToleranceFrame[] = dimensions.map((dimension, i) => {
      const target = dimension.targets[0]; if (target.kind !== 'subShape') throw new Error('実形状参照なし');
      return { id: `gdt-${i}`, feature: { kind: 'line', target }, position: [30 + i % 10 * 35, 260 - Math.floor(i / 10) * 20], height: 3.5, layerId: 'layer-5',
        segments: [{ characteristic: 'straightness', zone: 'betweenLines', material: 'none', datums: [], basicDimensionIds: [],
          tolerance: { expression: { source: '0.05', value: 0.05, display: '0.05' }, unit: 'mm' } }] };
    });
    const started = performance.now();
    const changed = { ...document, gdtFrames: frames.map((frame) => ({ ...frame, segments: frame.segments.map((row) => ({ ...row,
      tolerance: { ...row.tolerance, expression: { source: '0.1/2', value: 999, display: '999' } } })) })) };
    const resolution = resolveDrawingGdt(changed, context);
    const displays = displayDrawingGdt(changed, resolution, [], outline);
    const rendered = renderDrawing({ document: changed, views: [], elements: displays.map((item) => item.element) }, { forPrint: true, outlineText: outline });
    const svg = toSvg(rendered.document), elapsed = performance.now() - started;
    expect(resolution.unresolvedCount).toBe(0); expect(displays).toHaveLength(100); expect(displays.every((item) => !item.unresolved)).toBe(true);
    expect(rendered.issues).toEqual([]); expect(svg).toContain('data-owner-id="gdt-99"'); expect(svg).not.toContain('aria-label="999"');
    budget('100公差の編集/解決/配置/SVG', elapsed, 500);
  });
});
