import { note, type Annotation, type DrawingRenderElement, type OutlinedText, type RenderSubpath, type InkBounds } from '@pointercad/drawing';

export function drawingNoteBounds(annotation: Annotation, outline: (text: string, size: number) => OutlinedText): InkBounds | null {
  const display = displayDrawingNote(annotation, outline);
  if (display === null) return null;
  const bounds: InkBounds[] = [];
  for (const text of display.texts ?? []) {
    const metrics = outline(text.text, text.sizeMm).metrics;
    if (metrics === null || text.text.trim() === '') continue;
    bounds.push({ left: text.position[0] + metrics.inkBounds.left, right: text.position[0] + metrics.inkBounds.right,
      bottom: text.position[1], top: text.position[1] + metrics.inkBounds.top - metrics.inkBounds.bottom });
  }
  return bounds.length === 0 ? null : { left: Math.min(...bounds.map((item) => item.left)), right: Math.max(...bounds.map((item) => item.right)),
    bottom: Math.min(...bounds.map((item) => item.bottom)), top: Math.max(...bounds.map((item) => item.top)) };
}

/** 普通の注記は元部品の読込状態に依存せず、紙上の位置と字体だけで表示できる。 */
export function displayDrawingNote(annotation: Annotation, outline: (text: string, size: number) => OutlinedText): DrawingRenderElement | null {
  if (!['note', 'leaderNote', 'generalTolerance'].includes(annotation.kind)
    || annotation.sourceTarget !== undefined || annotation.machiningFeatureId !== undefined) return null;
  const target = annotation.kind === 'leaderNote' ? annotation.leader?.[0] : undefined;
  const geometry = note({ text: annotation.text, position: annotation.position, heightMm: annotation.height,
    ...(target === undefined ? {} : { leader: { target, end: annotation.leaderEnd ?? 'arrow' } }),
    measureText: (text, size) => outline(text, size).metrics });
  if (geometry === null) return null;
  const fills: NonNullable<DrawingRenderElement['fills']>[number][] = [];
  if (geometry.arrow !== null) {
    const [a, b, c] = geometry.arrow.points;
    fills.push({ fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: a }, { kind: 'L', to: b }, { kind: 'L', to: c }, { kind: 'Z' }] }] });
  }
  if (geometry.dot !== null) {
    const { center: [x, y], radius: r } = geometry.dot, k = r * 0.5522847498307936;
    const subpath: RenderSubpath = { commands: [
      { kind: 'M', to: [x + r, y] },
      { kind: 'C', control1: [x + r, y + k], control2: [x + k, y + r], to: [x, y + r] },
      { kind: 'C', control1: [x - k, y + r], control2: [x - r, y + k], to: [x - r, y] },
      { kind: 'C', control1: [x - r, y - k], control2: [x - k, y - r], to: [x, y - r] },
      { kind: 'C', control1: [x + k, y - r], control2: [x + r, y - k], to: [x + r, y] }, { kind: 'Z' },
    ] };
    fills.push({ fillRule: 'nonzero', subpaths: [subpath] });
  }
  return { ownerId: annotation.id, layerId: annotation.layerId, style: annotation.style,
    curves: geometry.lines.map((line) => ({ kind: 'segment', ...line })), texts: geometry.texts, fills };
}
