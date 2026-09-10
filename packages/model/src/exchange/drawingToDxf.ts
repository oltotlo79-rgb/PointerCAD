import { clipCurves, flattenRenderPath, LINE_DASH_PATTERNS, type AffineTransform2, type DrawingLayer,
  type DrawingLineType, type Point2, type RenderDocument, type RenderPath, type RenderPrimitive, type RenderText } from '@pointercad/drawing';
import type { DrawingDxfEntity, DrawingDxfLineType, DrawingDxfOptions } from './drawingDxfTypes.js';

export interface DrawingDxfGeometry {
  readonly entities: readonly DrawingDxfEntity[];
  readonly options: DrawingDxfOptions;
  readonly skippedPrimitiveCount: number;
  readonly flattenedCurveCount: number;
  readonly approximatedColorCount: number;
  readonly outlinedTextCount: number;
  /** R12に線幅属性は無い。描画の線幅を保存したと誤表示しないための明示情報。 */
  readonly lineWidthsPreserved: false;
}
export interface DrawingDxfConversionOptions {
  /** 製作指示の字体と位置を受け側のフォントに依存させない。輪郭線として保存する。 */
  readonly outlineTextOwnerIds?: ReadonlySet<string>;
}
const typeNames: Readonly<Record<DrawingLineType, string>> = {
  solid: 'CONTINUOUS', dashed: 'DASHED', chain: 'CENTER', chain2: 'PHANTOM', zigzag: 'CONTINUOUS',
};
const typeIds = ['solid', 'dashed', 'chain', 'chain2'] as const;
const lineTypes: readonly DrawingDxfLineType[] = typeIds.map((id) => ({ name: typeNames[id],
  segments: LINE_DASH_PATTERNS[id].map((value, index) => value * (index % 2 === 0 ? 1 : -1)) }));
const point = ([x, y]: Point2) => ({ x, y });
const project = (m: AffineTransform2, p: Point2): Point2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
function compose(a: AffineTransform2, b: AffineTransform2): AffineTransform2 {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
const palette = [
  { index: 7, rgb: [0, 0, 0] }, { index: 1, rgb: [255, 0, 0] }, { index: 2, rgb: [255, 255, 0] },
  { index: 3, rgb: [0, 255, 0] }, { index: 4, rgb: [0, 255, 255] }, { index: 5, rgb: [0, 0, 255] },
  { index: 6, rgb: [255, 0, 255] }, { index: 8, rgb: [128, 128, 128] }, { index: 9, rgb: [192, 192, 192] },
];
function aci(color: string): { readonly index: number; readonly approximate: boolean } | null {
  let hex = color === 'black' ? '#000000' : color;
  if (/^#[\da-f]{3}$/iu.test(hex)) hex = `#${[...hex.slice(1)].map((value) => value.repeat(2)).join('')}`;
  if (!/^#[\da-f]{6}$/iu.test(hex) || hex.toLowerCase() === '#ffffff') return null;
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  let best = palette[0], distance = Number.POSITIVE_INFINITY;
  for (const candidate of palette) {
    const next = rgb.reduce((sum, value, index) => sum + (value - candidate.rgb[index]) ** 2, 0);
    if (next < distance) { best = candidate; distance = next; }
  }
  return { index: best.index, approximate: distance > 0 };
}
function lineType(primitive: RenderPath): string | null {
  const dash = primitive.stroke?.dashMm ?? [];
  const type = typeIds.find((id) => LINE_DASH_PATTERNS[id].length === dash.length
    && LINE_DASH_PATTERNS[id].every((value, index) => Math.abs(value - dash[index]) < 1e-9));
  return type === undefined ? null : typeNames[type];
}
function convex(points: readonly Point2[]): boolean {
  let sign = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index], b = points[(index + 1) % points.length], c = points[(index + 2) % points.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-10) continue;
    if (sign !== 0 && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return sign !== 0;
}
function textEntity(text: RenderText, layer: string, color: number): DrawingDxfEntity | null {
  const m = text.transform, sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  // R12 TEXTの通常字形で表せない鏡像・せん断を普通の文字に変えない。
  if (!m.every(Number.isFinite) || sx <= 0 || Math.abs(sx - sy) > 1e-9
    || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 || m[0] * m[3] - m[1] * m[2] <= 0
    || text.clip !== null || !Number.isFinite(text.angle) || !Number.isFinite(text.metrics.sizeMm) || text.metrics.sizeMm <= 0) return null;
  const horizontal = text.anchor === 'middle' ? 1 : text.anchor === 'end' ? 2 : 0;
  const vertical = text.baseline === 'top' ? 3 : text.baseline === 'middle' ? 2 : text.baseline === 'bottom' ? 1 : 0;
  return { kind: 'text', layer, color, text: text.text, position: point(project(m, text.position)),
    height: text.metrics.sizeMm * sx, rotation: (text.angle + Math.atan2(m[1], m[0])) * 180 / Math.PI, horizontal, vertical };
}

function textOutlineTransform(text: RenderText): AffineTransform2 | null {
  if (text.clip !== null || text.outline === null) return null;
  const ink = text.metrics.inkBounds;
  const dx = text.anchor === 'middle' ? -text.metrics.advanceMm / 2 : text.anchor === 'end' ? -text.metrics.advanceMm : 0;
  const dy = text.baseline === 'top' ? -ink.top : text.baseline === 'middle' ? -(ink.top + ink.bottom) / 2 : text.baseline === 'bottom' ? -ink.bottom : 0;
  const c = Math.cos(text.angle), s = Math.sin(text.angle);
  const transform = compose(text.transform, [c, s, -s, c,
    text.position[0] + c * dx - s * dy, text.position[1] + s * dx + c * dy]);
  return transform.every(Number.isFinite) && Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) > 1e-12 ? transform : null;
}

/** 用紙上の共通IRをP6のR12書き手へ渡す。新しいDXF実体を混ぜず、省略は件数で返す。 */
export function drawingToDxf(document: RenderDocument, layers: readonly DrawingLayer[], toleranceMm = 0.001,
  options: DrawingDxfConversionOptions = {}): DrawingDxfGeometry {
  if (![document.widthMm, document.heightMm, toleranceMm].every((value) => Number.isFinite(value) && value > 0)
    || new Set(layers.map((layer) => layer.id)).size !== layers.length) throw new Error('図面の用紙またはレイヤーが正しくありません。');
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  const entities: DrawingDxfEntity[] = [];
  let skippedPrimitiveCount = 0, flattenedCurveCount = 0, approximatedColorCount = 0, outlinedTextCount = 0;
  const tableLayers = layers.map((layer) => {
    const color = aci(layer.color);
    if (color === null || color.approximate) approximatedColorCount += 1;
    return { name: layer.name, color: color?.index ?? 7, lineType: typeNames[layer.lineType], visible: layer.visible };
  });
  const append = (primitive: RenderPrimitive): boolean => {
    const layer = byId.get(primitive.layerId);
    if (layer === undefined) return false;
    const color = aci(primitive.kind === 'text' ? primitive.fill : primitive.stroke?.color ?? primitive.fill ?? layer.color);
    if (color === null) return false;
    const common = { layer: layer.name, color: color.index };
    const pending: DrawingDxfEntity[] = [];
    let flattened = 0, outlined = 0, approximate = color.approximate;
    if (primitive.kind === 'text') {
      if (options.outlineTextOwnerIds?.has(primitive.ownerId)) {
        const transform = textOutlineTransform(primitive);
        if (transform === null || primitive.outline === null || primitive.outline.length === 0 && primitive.text.trim().length > 0) return false;
        for (const subpath of primitive.outline) {
          const flat = flattenRenderPath(subpath, toleranceMm / 2, transform);
          if (flat === null || !flat.closed || flat.points.length < 3) return false;
          pending.push({ ...common, kind: 'polyline', lineType: 'CONTINUOUS', points: flat.points.map(point), closed: true });
          if (flat.curved) flattened += 1;
        }
        outlined = 1;
      } else {
        const text = textEntity(primitive, layer.name, color.index);
        if (text === null) return false;
        pending.push(text);
      }
    } else {
      const name = lineType(primitive);
      if (name === null) return false;
      const clip = primitive.clip;
      if (clip !== null && clip.subpaths.length !== 1) return false;
      const boundary = clip === null ? null : flattenRenderPath(clip.subpaths[0], toleranceMm / 2, compose(primitive.transform, clip.transform));
      if (clip !== null && (boundary === null || !boundary.closed)) return false;
      for (const subpath of primitive.subpaths) {
        const flat = flattenRenderPath(subpath, toleranceMm / 2, primitive.transform);
        if (flat === null || flat.points.length < 2) return false;
        if (flat.curved) flattened += 1;
        if (primitive.fill !== null) {
          const fill = aci(primitive.fill);
          if (fill === null || boundary !== null || primitive.subpaths.length !== 1 || !flat.closed || !convex(flat.points)) return false;
          approximate ||= fill.approximate;
          for (let index = 1; index + 1 < flat.points.length; index += 1) {
            const a = point(flat.points[0]), b = point(flat.points[index]), c = point(flat.points[index + 1]);
            pending.push({ ...common, color: fill.index, kind: 'solid', points: [a, b, c, c] });
          }
        }
        if (primitive.stroke === null) continue;
        if (boundary !== null) {
          const clipped = clipCurves([{ kind: 'polyline', points: flat.points, closed: flat.closed }], { kind: 'polygon', points: boundary.points });
          for (const curve of clipped) if (curve.kind === 'segment') pending.push({ ...common, lineType: name, kind: 'line', start: point(curve.from), end: point(curve.to) });
        } else if (flat.curved) pending.push({ ...common, lineType: name, kind: 'polyline', points: flat.points.map(point), closed: flat.closed });
        else {
          const vertices = flat.closed ? [...flat.points, flat.points[0]] : flat.points;
          for (let index = 0; index + 1 < vertices.length; index += 1) pending.push({ ...common, lineType: name, kind: 'line', start: point(vertices[index]), end: point(vertices[index + 1]) });
        }
      }
    }
    for (const entity of pending) entities.push(entity);
    flattenedCurveCount += flattened;
    outlinedTextCount += outlined;
    if (approximate) approximatedColorCount += 1;
    return true;
  };
  for (const primitive of document.primitives) if (!append(primitive)) skippedPrimitiveCount += 1;
  return { entities, options: { layers: tableLayers, lineTypes }, skippedPrimitiveCount, flattenedCurveCount, approximatedColorCount,
    outlinedTextCount, lineWidthsPreserved: false };
}
