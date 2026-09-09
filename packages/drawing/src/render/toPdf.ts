import type { AffineTransform2, RenderDocument, RenderPrimitive, RenderSubpath, RenderText } from './types.js';
import { createPdf, PDF_POINTS_PER_MM, type PdfOptions, type PdfResult } from './pdfWriter.js';

const identity: AffineTransform2 = [1, 0, 0, 1, 0, 0];
const fixed = (value: number): string => (Object.is(value, -0) ? 0 : value).toFixed(4);
const points = (value: number): string => fixed(value * PDF_POINTS_PER_MM);
const basicColors: Readonly<Record<string, string>> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
  cyan: '00ffff', aqua: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff', gray: '808080', grey: '808080',
  silver: 'c0c0c0', maroon: '800000', olive: '808000', lime: '00ff00', teal: '008080', navy: '000080', purple: '800080',
};
function color(value: string): string | null {
  let hex = value.startsWith('#') ? value.slice(1) : basicColors[value.toLowerCase()];
  if (hex === undefined) return null;
  if (/^[\da-f]{3}$/iu.test(hex)) hex = [...hex].map((character) => character.repeat(2)).join('');
  // 半透明はresourceにExtGStateが必要。未実装の指定を不透明へ黙って置き換えない。
  if (!/^[\da-f]{6}$/iu.test(hex)) return null;
  return [0, 2, 4].map((offset) => fixed(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)).join(' ');
}
function matrix(value: AffineTransform2): string | null {
  return value.length === 6 && value.every(Number.isFinite)
    ? `${value.slice(0, 4).map(fixed).join(' ')} ${points(value[4])} ${points(value[5])} cm` : null;
}
function paths(subpaths: readonly RenderSubpath[], transform: AffineTransform2 = identity): string | null {
  if (!transform.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f] = transform;
  const point = (value: readonly number[]): string | null => value.length === 2 && value.every(Number.isFinite)
    ? `${points(a * value[0] + c * value[1] + e)} ${points(b * value[0] + d * value[1] + f)}` : null;
  const output: string[] = [];
  for (const subpath of subpaths) {
    if (subpath.commands[0]?.kind !== 'M') return null;
    let closed = false;
    for (const [index, command] of subpath.commands.entries()) {
      if (closed || (index > 0 && command.kind === 'M')) return null;
      if (command.kind === 'Z') { output.push('h'); closed = true; continue; }
      const end = point(command.to);
      if (end === null) return null;
      if (command.kind === 'C') {
        const first = point(command.control1), second = point(command.control2);
        if (first === null || second === null) return null;
        output.push(`${first} ${second} ${end} c`);
      } else output.push(`${end} ${command.kind === 'M' ? 'm' : 'l'}`);
    }
  }
  return output.join('\n');
}
function textPlacement(text: RenderText): string | null {
  const { inkBounds: bounds, advanceMm, sizeMm } = text.metrics;
  if (![...text.position, text.angle, advanceMm, sizeMm, bounds.left, bounds.right, bounds.bottom, bounds.top].every(Number.isFinite)
    || sizeMm <= 0 || advanceMm < 0 || bounds.left > bounds.right || bounds.bottom > bounds.top) return null;
  const dx = text.anchor === 'middle' ? -advanceMm / 2 : text.anchor === 'end' ? -advanceMm : 0;
  const dy = text.baseline === 'top' ? -bounds.top : text.baseline === 'bottom' ? -bounds.bottom
    : text.baseline === 'middle' ? -(bounds.top + bounds.bottom) / 2 : 0;
  const cos = Math.cos(text.angle), sin = Math.sin(text.angle);
  return `${matrix([cos, sin, -sin, cos, ...text.position])}\n1 0 0 1 ${points(dx)} ${points(dy)} cm`;
}
function primitiveCommands(primitive: RenderPrimitive): string | null {
  const transform = matrix(primitive.transform);
  if (transform === null) return null;
  const output = ['q'];
  if (!primitive.transform.every((value, index) => value === identity[index])) output.push(transform);
  if (primitive.clip !== null) {
    const clip = paths(primitive.clip.subpaths, primitive.clip.transform);
    if (clip === null || !['nonzero', 'evenodd'].includes(primitive.clip.fillRule)) return null;
    output.push(clip, primitive.clip.fillRule === 'evenodd' ? 'W* n' : 'W n');
  }
  const fill = primitive.fill === null ? null : color(primitive.fill);
  if (primitive.fill !== null && fill === null) return null;
  if (fill !== null && fill !== '0.0000 0.0000 0.0000') output.push(`${fill} rg`);
  if (primitive.kind === 'text') {
    if (primitive.outline === null) return null;
    const textTransform = textPlacement(primitive), body = paths(primitive.outline);
    if (textTransform === null || body === null) return null;
    output.push(textTransform, body, 'f');
  } else {
    if (!['nonzero', 'evenodd'].includes(primitive.fillRule)) return null;
    if (primitive.stroke !== null) {
      const stroke = primitive.stroke, rgb = color(stroke.color);
      if (rgb === null || !Number.isFinite(stroke.widthMm) || stroke.widthMm < 0
        || stroke.dashMm.some((value) => !Number.isFinite(value) || value < 0)
        || (stroke.dashMm.length > 0 && stroke.dashMm.every((value) => value === 0))) return null;
      if (rgb !== '0.0000 0.0000 0.0000') output.push(`${rgb} RG`);
      output.push(`${points(stroke.widthMm)} w`);
      if (stroke.dashMm.length > 0) output.push(`[${stroke.dashMm.map(points).join(' ')}] 0 d`);
    }
    const body = paths(primitive.subpaths);
    if (body === null) return null;
    const operator = primitive.fill === null ? primitive.stroke === null ? 'n' : 'S'
      : `${primitive.stroke === null ? 'f' : 'B'}${primitive.fillRule === 'evenodd' ? '*' : ''}`;
    output.push(body, operator);
  }
  output.push('Q');
  return output.join('\n');
}

/** 共通IRは左下原点mm。PDFも上向きなのでSVGのY反転は持ち込まない。 */
export function toPdf(document: RenderDocument, metadata: Pick<PdfOptions, 'creationDate' | 'title'> = {}): PdfResult {
  const content: string[] = [];
  for (const primitive of document.primitives) {
    const commands = primitiveCommands(primitive);
    if (commands === null) return { ok: false, reason: 'invalidContent' };
    content.push(commands);
  }
  return createPdf({ ...metadata, widthMm: document.widthMm, heightMm: document.heightMm, content: content.join('\n') });
}
