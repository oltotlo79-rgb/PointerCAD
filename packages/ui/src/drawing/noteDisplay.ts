import { note, type Annotation, type DrawingRenderElement, type OutlinedText, type RenderSubpath, type InkBounds, type NoteGeometry } from '@pointercad/drawing';

/** 注記の文字の置き換え(係数の差し込み {=名前}。drawingNoteFields)。省くと原文のまま。 */
type NoteTextFields = (text: string) => string;

export function drawingNoteBounds(annotation: Annotation, outline: (text: string, size: number) => OutlinedText,
  fields?: NoteTextFields): InkBounds | null {
  const display = displayDrawingNote(annotation, outline, fields);
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

/** 普通の注記は紙上の位置と字体で表示できる。係数の差し込み {=名前} だけは元部品を読む(fields。元が無ければ原文のまま)。 */
export function displayDrawingNote(annotation: Annotation, outline: (text: string, size: number) => OutlinedText,
  fields?: NoteTextFields): DrawingRenderElement | null {
  if (!['note', 'leaderNote', 'generalTolerance'].includes(annotation.kind)
    || annotation.sourceTarget !== undefined || annotation.machiningFeatureId !== undefined) return null;
  const target = annotation.kind === 'leaderNote' ? annotation.leader?.[0] : undefined;
  const geometry = note({ text: fields === undefined ? annotation.text : fields(annotation.text), position: annotation.position,
    heightMm: annotation.height,
    ...(target === undefined ? {} : { leader: { target, end: annotation.leaderEnd ?? 'arrow' } }),
    measureText: (text, size) => outline(text, size).metrics });
  if (geometry === null) return null;
  return drawingNoteGeometryElement(annotation, geometry);
}

/** 穴表の記号も普通の引出線と同じ矢印・線・文字を描く。 */
export function drawingNoteGeometryElement(annotation: Pick<Annotation, 'id' | 'layerId' | 'style'>, geometry: NoteGeometry): DrawingRenderElement {
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
