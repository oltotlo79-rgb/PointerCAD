import { expressionValueFromNumber } from '@pointercad/expression';
import type { OutlinedText, WeldSymbol } from '@pointercad/drawing';
import {
  addComponent, createAssemblyDocument, createComponentFor, createDrawingDocument, embedDrawingSource, resolveDrawingWelds,
  type AssemblyDocument, type MateSubShapeGeometry, type MateTarget, type Placement, type SubShapeRef, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { TEE_PLANE_BODIES } from '../assembly/filletWeldBodies.testSupport.js';
import {
  appendFilletWeldPick, commitFilletWeldDraft, createFilletWeldDraft, previewFilletWeldDraft,
  type AssemblyFilletWeldDraft, type FilletWeldDraftContext,
} from '../assembly/filletWeldDraft.js';
import type { OutlineDrawingText } from './dimensionDisplay.js';
import { displayDrawingWelds } from './weldDisplay.js';

const REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);
const placement = (position: Vec3): Placement => ({ position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
  expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] });
const ref = (index: number, kind: 'face' | 'edge'): SubShapeRef => ({ bodyFeatureId: 'extrude-1', index, fingerprint: kind === 'face'
  ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null }
  : { kind: 'edge', curveKind: 'line', length: 1, position: [0, 0, 0], axis: [1, 0, 0], radius: null } });
const target = (componentId: string, index: number, kind: 'face' | 'edge'): MateTarget => ({ kind: 'subShape', componentId, ref: ref(index, kind) });
/** The tee of filletWeldDraft.test.ts: standing plate side 1 and bottom edge 2, base top 3; contact 0..100 along +X. */
const SHAPES = new Map<string, MateSubShapeGeometry>([
  ['component-1:1', { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }],
  ['component-1:2', { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }],
  ['component-2:3', { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null }],
]);

function tee(): AssemblyDocument {
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
}

function welded(patch: Partial<AssemblyFilletWeldDraft>): AssemblyDocument {
  let draft = createFilletWeldDraft('doc');
  for (const pick of [target('component-1', 1, 'face'), target('component-1', 2, 'edge'), target('component-2', 3, 'face')]) {
    draft = appendFilletWeldPick(draft, pick) ?? draft;
  }
  draft = { ...draft, materialId: 'steel', ...patch };
  const document = tee();
  const context: FilletWeldDraftContext = { document, partRevisions: REVISIONS, bodiesOf: TEE_PLANE_BODIES,
    resolve: (component, reference) => SHAPES.get(`${component.id}:${String(reference.index)}`) ?? null };
  const preview = previewFilletWeldDraft(context, draft);
  if (preview.kind !== 'plan' || !preview.result.ok) throw new Error(JSON.stringify(preview));
  const committed = commitFilletWeldDraft(context, draft, preview.result.plan);
  if (!committed.ok) throw new Error(JSON.stringify(committed));
  return committed.document;
}

const length = (value: number) => ({ expression: { source: String(value), value, display: String(value) }, unit: 'mm' as const });
function symbol(id: string, weldId?: string): WeldSymbol {
  return { id, system: 'B', target: { kind: 'point', viewId: 'view-1', paperPoint: [0, 0] },
    sides: [{ kind: 'fillet', side: 'arrow', size: { kind: 'leg', value: length(6) }, length: length(20), contour: 'none', finish: 'none' }],
    allAround: false, fieldWeld: false, tail: '', position: [40, 60], height: 3.5, layerId: 'layer-5', ...(weldId === undefined ? {} : { weldId }) };
}

/**
 * A deterministic measured outline: every character is half the text height wide, ink 0.2 h below to 0.8 h above the
 * baseline. No standard symbol geometry is drawn for a point target, so only the supplementary lines are measured.
 */
const measured: OutlineDrawingText = (text, sizeMm): OutlinedText => ({ status: 'ready', subpaths: [], fillRule: 'nonzero', missingCharacters: [],
  metrics: { fontId: 'test', sizeMm, advanceMm: [...text].length * sizeMm / 2,
    inkBounds: { left: 0, right: [...text].length * sizeMm / 2, bottom: -0.2 * sizeMm, top: 0.8 * sizeMm } } });
/** A font that is not loaded yet: no metrics. */
const unmeasured: OutlineDrawingText = (): OutlinedText => ({ status: 'loading', subpaths: [], fillRule: 'nonzero', missingCharacters: [], metrics: null });

async function drawingWith(assembly: AssemblyDocument, symbols: readonly WeldSymbol[]) {
  const embedded = await embedDrawingSource({ sources: [] }, { sourceKind: 'assembly', document: assembly }, '組立.pcadasm', '組立.pcadasm');
  const drawing = { ...createDrawingDocument('溶接図', embedded.source), weldSymbols: [...symbols] };
  return { drawing, library: embedded.library, resolved: resolveDrawingWelds(drawing, { instances: [], modelCenter: [0, 0, 0] }) };
}

const irregular = (): AssemblyDocument => welded({ legOnSecondSource: '6', legOnFirstSource: '8', mode: 'intermittent', startSource: '10',
  lengthsSource: '20, 15, 25', gapsSource: '10, 15' });

describe('linked weld symbols on the drawing and in export', () => {
  it('keeps an irregular unequal-leg linked symbol unresolved in red and lists every bead, gap, both legs and the extent', async () => {
    const { drawing, library, resolved } = await drawingWith(irregular(), [symbol('weld-symbol-1', 'weld-1'), symbol('weld-symbol-2')]);
    const [linked, manual] = displayDrawingWelds(drawing, resolved, measured, library);
    expect(linked?.unresolved).toBe(true);
    expect(linked?.element.style).toEqual({ color: '#b91c1c' });
    expect(linked?.messages.filter((message) => message.includes('補足の一覧'))).toHaveLength(2);
    expect(linked?.element.texts?.slice(1).map((text) => text.text)).toEqual([
      '溶接 weld-1 の実際の値（溶接記号ではありません）',
      '脚長: 2つ目の面 6 mm、1つ目の面 8 mm',
      '範囲: 10〜95 mm（当たりの長さ 100 mm）',
      'ビード1: 始点 10 mm、終点 30 mm、長さ 20 mm',
      'ビード2: 始点 40 mm、終点 55 mm、長さ 15 mm',
      'ビード3: 始点 70 mm、終点 95 mm、長さ 25 mm',
      '間隔1: 10 mm',
      '間隔2: 15 mm',
    ]);
    // The independent manual symbol is neither checked against the weld nor given the list, and keeps its own box.
    expect(manual?.messages.some((message) => message.includes('結び付けた溶接'))).toBe(false);
    expect(manual?.element.texts).toHaveLength(1);
    expect(manual?.bounds).toEqual({ left: 40, bottom: 60, right: 56, top: 67 });
  });

  it('selects the linked symbol from a point on its lowest supplementary line (bounds include the measured list)', async () => {
    const { drawing, library, resolved } = await drawingWith(irregular(), [symbol('weld-symbol-1', 'weld-1')]);
    const [display] = displayDrawingWelds(drawing, resolved, measured, library);
    const lines = display?.element.texts?.slice(1) ?? [];
    expect(lines).toHaveLength(8);
    // Symbol box bottom 60; line n (1-based) baseline 60 - n x 3.5 x 1.6; the 8th baseline is 15.2, its ink reaches 15.2 - 0.7.
    const lowest = lines[7];
    expect(lowest?.position[1]).toBeCloseTo(15.2, 9);
    expect(display?.bounds.bottom).toBeCloseTo(14.5, 9);
    expect(display?.bounds.top).toBe(67);
    const widest = Math.max(...lines.map((line) => 40 + [...line.text].length * 3.5 / 2));
    expect(display?.bounds.right).toBeCloseTo(widest, 9);
    // A click in the middle of the lowest line hits the box; the symbol-only box (bottom 60) would have missed it.
    const point = [40 + [...(lowest?.text ?? '')].length * 3.5 / 4, 15.2 + 0.3 * 3.5] as const;
    const bounds = display?.bounds;
    expect(bounds !== undefined && point[0] >= bounds.left && point[0] <= bounds.right && point[1] >= bounds.bottom && point[1] <= bounds.top).toBe(true);
    expect(point[1] < 60).toBe(true);
  });

  it('keeps unmeasured supplementary lines selectable with a conservative box before the font is loaded', async () => {
    const { drawing, library, resolved } = await drawingWith(irregular(), [symbol('weld-symbol-1', 'weld-1')]);
    const [display] = displayDrawingWelds(drawing, resolved, unmeasured, library);
    // One character = one text height wide, 0.3 h below the baseline: 15.2 - 1.05.
    expect(display?.bounds.bottom).toBeCloseTo(14.15, 9);
    const lines = display?.element.texts?.slice(1) ?? [];
    expect(display?.bounds.right).toBeCloseTo(Math.max(...lines.map((line) => 40 + [...line.text].length * 3.5)), 9);
  });

  it('reports a link to a weld that is not in the embedded assembly, without a list', async () => {
    const { drawing, library, resolved } = await drawingWith(welded({ legOnSecondSource: '6', legOnFirstSource: '6' }),
      [symbol('weld-symbol-1', 'weld-9')]);
    const [display] = displayDrawingWelds(drawing, resolved, measured, library);
    expect(display?.unresolved).toBe(true);
    expect(display?.messages.some((message) => message.includes('見つかりません'))).toBe(true);
    expect(display?.element.texts).toHaveLength(1);
    expect(display?.bounds).toEqual({ left: 40, bottom: 60, right: 56, top: 67 });
  });

  it('does not check links when no source library is given (unchanged callers)', async () => {
    const { drawing, resolved } = await drawingWith(irregular(), [symbol('weld-symbol-1', 'weld-1')]);
    const [display] = displayDrawingWelds(drawing, resolved, measured);
    expect(display?.messages.some((message) => message.includes('結び付けた溶接'))).toBe(false);
    expect(display?.element.texts).toHaveLength(1);
  });
});
