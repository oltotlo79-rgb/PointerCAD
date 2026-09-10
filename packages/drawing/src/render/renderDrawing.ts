import type { DrawingDocument, DrawingElementStyle, Point2 } from '../types.js';
import type { PathCommand, RenderClip, RenderDocument, RenderPrimitive, RenderStroke, RenderSubpath, RenderText } from './types.js';
import { bezierArc } from './bezierArc.js';
import { paperSizeOf } from '../paper/paperSize.js';
import { createPaperFrame } from '../paper/frame.js';
import { createTitleBlock, formatDrawingScale } from '../paper/titleBlock.js';
import { generalToleranceNote } from '../annotation/generalTolerance.js';
import { drawingSymbol } from '../annotation/symbols.js';
import { resolveStyle } from '../style/layers.js';
import { LINE_DASH_PATTERNS } from '../style/jisStyle.js';
import type { OutlinedText } from '../text/fontStore.js';

const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
export type DrawingRenderCurve =
  | { readonly kind: 'segment'; readonly from: Point2; readonly to: Point2 }
  | { readonly kind: 'arc'; readonly center: Point2; readonly radius: number; readonly startAngle: number; readonly endAngle: number }
  | { readonly kind: 'polyline'; readonly points: readonly Point2[]; readonly closed: boolean };

/** 寸法の矢印・ハッチング・記号も同じ紙面mmのパスへ渡す。由来の解決はmodelの責務。 */
export interface DrawingRenderElement {
  readonly ownerId: string;
  readonly viewId?: string;
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
  readonly curves?: readonly DrawingRenderCurve[];
  readonly fills?: readonly { readonly subpaths: readonly RenderSubpath[]; readonly fillRule: 'nonzero' | 'evenodd' }[];
  readonly texts?: readonly {
    readonly text: string; readonly position: Point2; readonly sizeMm: number;
    readonly angle?: number; readonly anchor?: RenderText['anchor']; readonly baseline?: RenderText['baseline'];
  }[];
  readonly clip?: RenderClip | null;
}
export interface DrawingRenderView {
  readonly viewId: string;
  readonly visible: readonly { readonly curve: DrawingRenderCurve; readonly ownerId?: string }[];
  readonly hidden: readonly { readonly curve: DrawingRenderCurve; readonly ownerId?: string }[];
  readonly cuttingCurves: readonly DrawingRenderCurve[];
  readonly breakCurves?: readonly DrawingRenderCurve[];
  readonly hatchCurves?: readonly DrawingRenderCurve[];
  readonly centerCurves?: readonly DrawingRenderCurve[];
  /** 切断線と詳細範囲の符号。ownerIdは対応する派生図のID。 */
  readonly decorations?: readonly DrawingRenderElement[];
}
export interface RenderDrawingOptions {
  readonly forPrint?: boolean;
  readonly outlineText: (text: string, sizeMm: number) => OutlinedText;
  readonly frameLayerId?: string;
  readonly hiddenLayerId?: string;
  readonly centerLayerId?: string;
  readonly hatchLayerId?: string;
  readonly annotationLayerId?: string;
}
export interface DrawingRenderIssue {
  readonly ownerId: string;
  readonly kind: 'layer' | 'font' | 'geometry';
  readonly text?: string;
}
export interface DrawingRenderResult {
  readonly document: RenderDocument;
  readonly issues: readonly DrawingRenderIssue[];
}

function curvePath(curve: DrawingRenderCurve): readonly RenderSubpath[] | null {
  if (curve.kind === 'arc') {
    const arc = bezierArc(curve);
    return arc === null ? null : [{ commands: [{ kind: 'M', to: arc.start }, ...arc.segments.map((segment): PathCommand => ({
      kind: 'C', control1: segment.control1, control2: segment.control2, to: segment.to,
    }))] }];
  }
  const points = curve.kind === 'segment' ? [curve.from, curve.to] : curve.points;
  if (points.length === 0) return [];
  if (points.some((point) => !point.every(Number.isFinite))) return null;
  const commands: PathCommand[] = points.map((to, index) => ({ kind: index === 0 ? 'M' : 'L', to }));
  if (curve.kind === 'polyline' && curve.closed) commands.push({ kind: 'Z' });
  return [{ commands }];
}

/** 同じ中間表現で変更要素だけを描く。用紙・投影・無関係な文字を再生成しない。 */
export function renderDrawingElements(drawing: DrawingDocument, elements: readonly DrawingRenderElement[],
  options: RenderDrawingOptions): DrawingRenderResult {
  const paper = paperSizeOf(drawing.sheet.paperSizeId);
  if (paper === undefined) throw new Error('知らない用紙です。');
  const primitives: RenderPrimitive[] = [], issues: DrawingRenderIssue[] = [];
  for (const element of elements) appendDrawingElement(element, drawing, options, primitives, issues);
  return { document: { widthMm: paper.width, heightMm: paper.height, primitives }, issues };
}

function appendDrawingElement(element: DrawingRenderElement, drawing: DrawingDocument, options: RenderDrawingOptions,
  primitives: RenderPrimitive[], issues: DrawingRenderIssue[]): void {
  const style = resolveStyle(element, drawing.layers);
  if (style === null) { issues.push({ ownerId: element.ownerId, kind: 'layer' }); return; }
  if (!style.visible || (options.forPrint === true && !style.printable)) return;
  const common = { ownerId: element.ownerId, ...(element.viewId === undefined ? {} : { viewId: element.viewId }), layerId: element.layerId, clip: element.clip ?? null, transform: IDENTITY };
  const stroke: RenderStroke = { color: style.color, widthMm: style.lineWidth, dashMm: LINE_DASH_PATTERNS[style.lineType] };
  for (const curve of element.curves ?? []) {
    const subpaths = curvePath(curve);
    if (subpaths === null) { issues.push({ ownerId: element.ownerId, kind: 'geometry' }); continue; }
    primitives.push({ ...common, kind: 'path', subpaths, stroke, fill: null, fillRule: 'nonzero' });
  }
  for (const fill of element.fills ?? []) primitives.push({ ...common, ...fill, kind: 'path', stroke: null, fill: style.color });
  for (const text of element.texts ?? []) {
    const outline = options.outlineText(text.text, text.sizeMm);
    if (outline.status !== 'ready' || outline.metrics === null) {
      issues.push({ ownerId: element.ownerId, kind: 'font', text: text.text });
      // 不確かな字体で印刷しない。画面の未読込印だけを輪郭の枠で表す。
      if (options.forPrint !== true) primitives.push({ ...common, kind: 'path', subpaths: outline.subpaths,
        transform: [1, 0, 0, 1, text.position[0], text.position[1]], fillRule: 'nonzero', fill: null, stroke });
      continue;
    }
    primitives.push({ ...common, kind: 'text', text: text.text, position: text.position, angle: text.angle ?? 0,
      anchor: text.anchor ?? 'start', baseline: text.baseline ?? 'alphabetic', metrics: outline.metrics,
      outline: outline.subpaths, fill: style.color });
  }
}

/** 用紙を一つの決定的な中間表現へ写す。文字の実測は字体キャッシュへ注入する(P8-41)。 */
export function renderDrawing(input: {
  readonly document: DrawingDocument;
  readonly views: readonly DrawingRenderView[];
  readonly elements?: readonly DrawingRenderElement[];
}, options: RenderDrawingOptions): DrawingRenderResult {
  const drawing = input.document;
  const paper = paperSizeOf(drawing.sheet.paperSizeId);
  if (paper === undefined) throw new Error('知らない用紙です。');
  const primitives: RenderPrimitive[] = [];
  const issues: DrawingRenderIssue[] = [];
  const append = (element: DrawingRenderElement): void => appendDrawingElement(element, drawing, options, primitives, issues);
  const frameLayerId = options.frameLayerId ?? 'layer-7';
  const frame = createPaperFrame(paper);
  const title = createTitleBlock({ paper, fields: drawing.sheet.titleBlockFields });
  const titleTextHeight = drawing.sheet.textHeight ?? 3.5;
  if (drawing.sheet.frame.visible) append({ ownerId: `${drawing.id}:frame`, layerId: frameLayerId,
    curves: [...frame.border, ...frame.centerMarks].map((line) => ({ kind: 'segment', from: line.from, to: line.to })) });
  if (title !== null) {
    const ownerId = `${drawing.id}:title`;
    const lines: DrawingRenderCurve[] = [
      { kind: 'polyline', closed: true, points: [[title.left, title.bottom], [title.right, title.bottom], [title.right, title.top], [title.left, title.top]] },
      { kind: 'segment', from: [title.left, (title.top + title.bottom) / 2], to: [title.right, (title.top + title.bottom) / 2] },
      ...title.fields.slice(1).map((cell): DrawingRenderCurve => ({ kind: 'segment', from: [cell.left, cell.bottom], to: [cell.left, cell.top] })),
    ];
    const texts: NonNullable<DrawingRenderElement['texts']>[number][] = [];
    const values: Readonly<Record<string, string>> = { ...drawing.sheet.titleBlock, scale: formatDrawingScale(drawing.sheet.scale) };
    for (const cell of title.fields) {
      const fitText = (text: string, y: number): void => {
        if (text.length === 0) return;
        const measured = options.outlineText(text, titleTextHeight).metrics;
        const width = measured === null ? 0 : measured.inkBounds.right - measured.inkBounds.left;
        const available = cell.right - cell.left - 2;
        const sizeMm = Math.max(Math.min(2.5, titleTextHeight), width <= 0 ? titleTextHeight : titleTextHeight * Math.min(1, available / width));
        const rows: string[] = [];
        let row = '';
        for (const character of Array.from(text)) {
          if (character === '\n') { rows.push(row); row = ''; continue; }
          const metrics = options.outlineText(row + character, sizeMm).metrics;
          if (row.length > 0 && metrics !== null && metrics.inkBounds.right - metrics.inkBounds.left > available) {
            rows.push(row); row = character;
          } else row += character;
        }
        rows.push(row);
        const lineHeight = sizeMm * 1.5;
        // 読めない極小文字へ縮めない。入り切らない本文も消さず、出力側へ問題を返す。
        if (rows.length * lineHeight > title.height / 2 - 2) issues.push({ ownerId, kind: 'geometry', text });
        rows.forEach((line, index) => texts.push({ text: line, position: [(cell.left + cell.right) / 2, y + ((rows.length - 1) / 2 - index) * lineHeight],
          sizeMm, anchor: 'middle', baseline: 'middle' }));
      };
      fitText(cell.field.label, cell.bottom + title.height * 0.75);
      if (cell.field.key !== 'projection') fitText(cell.field.fixedText ?? values[cell.field.key] ?? '', cell.bottom + title.height * 0.25);
    }
    append({ ownerId, layerId: frameLayerId, curves: lines, texts });
    const projectionCell = title.fields.find((cell) => cell.field.key === 'projection');
    if (projectionCell !== undefined) {
      const size = 3.5 * Math.min(1, (projectionCell.right - projectionCell.left - 2) / 20);
      const symbol = drawingSymbol('thirdAngle', size,
        [(projectionCell.left + projectionCell.right) / 2, projectionCell.bottom + title.height * 0.25]);
      if (symbol !== null) {
        append({ ownerId: `${ownerId}:projection`, layerId: frameLayerId,
          curves: [...symbol.lines.map((line): DrawingRenderCurve => ({ kind: 'segment', ...line })),
            ...symbol.arcs.map((arc): DrawingRenderCurve => ({ kind: 'arc', ...arc }))] });
        append({ ownerId: `${ownerId}:projection`, layerId: frameLayerId, style: { lineType: 'chain', lineWidth: 0.25 },
          curves: symbol.centerLines.map((line): DrawingRenderCurve => ({ kind: 'segment', ...line })) });
      }
    }
    const grade = drawing.sheet.generalTolerance;
    if (grade !== undefined && ['f', 'm', 'c', 'v'].includes(grade)) {
      const note = generalToleranceNote({ titleBlockRight: title.right, titleBlockTop: title.top, grade });
      if (note !== null) append({ ownerId: `${drawing.id}:generalTolerance`, layerId: options.annotationLayerId ?? 'layer-5',
        texts: [{ text: note.text, position: note.position, sizeMm: note.sizeMm, anchor: note.anchor, baseline: note.baseline }] });
    }
  }
  for (const view of input.views) {
    const appendView = (element: DrawingRenderElement): void => append({ ...element, viewId: view.viewId });
    const source = drawing.views.find((candidate) => candidate.id === view.viewId);
    if (source === undefined) continue;
    const sourceStyle = resolveStyle(source, drawing.layers);
    if (sourceStyle === null) { issues.push({ ownerId: view.viewId, kind: 'layer' }); continue; }
    if (!sourceStyle.visible || options.forPrint === true && !sourceStyle.printable) continue;
    for (const item of view.visible) appendView({ ownerId: item.ownerId ?? view.viewId,
      layerId: source.layerId, style: source.style, curves: [item.curve] });
    appendView({ ownerId: view.viewId, layerId: source.layerId, style: source.style, curves: view.cuttingCurves });
    if (view.breakCurves !== undefined) appendView({ ownerId: view.viewId, layerId: source.layerId,
      style: { ...source.style, lineType: 'solid', lineWidth: 0.25 }, curves: view.breakCurves });
    if (view.hatchCurves !== undefined) appendView({ ownerId: view.viewId,
      layerId: options.hatchLayerId ?? (drawing.layers.some((layer) => layer.id === 'layer-6') ? 'layer-6' : source.layerId), curves: view.hatchCurves });
    if (source.showCenterLines && view.centerCurves !== undefined) appendView({ ownerId: view.viewId,
      layerId: options.centerLayerId ?? (drawing.layers.some((layer) => layer.id === 'layer-3') ? 'layer-3' : source.layerId), curves: view.centerCurves });
    if (source.showHidden) for (const item of view.hidden) appendView({ ownerId: item.ownerId ?? view.viewId,
      layerId: options.hiddenLayerId ?? 'layer-2', curves: [item.curve] });
    for (const decoration of view.decorations ?? []) {
      const owner = drawing.views.find((candidate) => candidate.id === decoration.ownerId);
      const ownerStyle = owner === undefined ? null : resolveStyle(owner, drawing.layers);
      if (ownerStyle === null || !ownerStyle.visible || options.forPrint === true && !ownerStyle.printable) continue;
      appendView(decoration);
    }
  }
  for (const element of input.elements ?? []) append(element);
  for (const annotation of drawing.annotations) {
    // 表面性状は解決済みelementsへ記号を渡す。本文を二重に出さない。
    if ((input.elements ?? []).some((element) => element.ownerId === annotation.id)) continue;
    append({ ownerId: annotation.id, layerId: annotation.layerId, style: annotation.style,
      curves: annotation.leader === undefined ? [] : [{ kind: 'polyline', points: annotation.leader, closed: false }],
      texts: [{ text: annotation.text, position: annotation.position, sizeMm: annotation.height }] });
  }
  return { document: { widthMm: paper.width, heightMm: paper.height, primitives }, issues };
}
