import type { AffineTransform2, PathCommand, RenderDocument, RenderPrimitive, RenderSubpath, RenderText } from './types.js';

export interface SvgOptions {
  /** 輪郭を既定とする。semanticは文字として編集するための明示指定。 */
  readonly textMode?: 'outline' | 'semantic';
}

function xml(value: string): string | null {
  // XML 1.0に書けない文字を黙って削らない。サロゲート単独も断る。
  for (const character of value) {
    const cp = character.codePointAt(0) ?? 0;
    if ((cp < 32 && cp !== 9 && cp !== 10 && cp !== 13)
      || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) return null;
  }
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function number(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

function matrix(value: AffineTransform2): string | null {
  return value.length === 6 && value.every(Number.isFinite) ? `matrix(${value.map(number).join(' ')})` : null;
}

function point(value: readonly number[]): string | null {
  return value.length === 2 && value.every(Number.isFinite) ? value.map(number).join(' ') : null;
}

function commandText(command: PathCommand): string | null {
  if (command.kind === 'Z') return 'Z';
  if (command.kind !== 'M' && command.kind !== 'L' && command.kind !== 'C') return null;
  const to = point(command.to);
  if (to === null) return null;
  if (command.kind !== 'C') return `${command.kind} ${to}`;
  const first = point(command.control1);
  const second = point(command.control2);
  return first === null || second === null ? null : `C ${first} ${second} ${to}`;
}

/** 複合パスのM/C/Zを保つ。穴を別の塗りつぶし要素に分解しない。 */
function pathData(subpaths: readonly RenderSubpath[]): string | null {
  const parts: string[] = [];
  for (const subpath of subpaths) {
    if (subpath.commands.length === 0 || subpath.commands[0].kind !== 'M') return null;
    let closed = false;
    for (let i = 0; i < subpath.commands.length; i += 1) {
      const command = subpath.commands[i];
      if ((i > 0 && command.kind === 'M') || closed) return null;
      const text = commandText(command);
      if (text === null) return null;
      parts.push(text);
      closed = command.kind === 'Z';
    }
  }
  return parts.join(' ');
}

/** 外部URLをpaintとして通さない。アプリの色指定とSVGの基本色名を扱う。 */
function paint(value: string): string | null {
  return /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+)$/iu.test(value) ? value : null;
}

function textPlacement(text: RenderText): string | null {
  const metrics = text.metrics;
  const bounds = metrics.inkBounds;
  if (![text.angle, metrics.advanceMm, metrics.sizeMm, bounds.left, bounds.bottom, bounds.right, bounds.top].every(Number.isFinite)
    || metrics.advanceMm < 0 || metrics.sizeMm <= 0 || bounds.left > bounds.right || bounds.bottom > bounds.top) return null;
  const position = point(text.position);
  if (position === null) return null;
  const dx = text.anchor === 'middle' ? -metrics.advanceMm / 2 : text.anchor === 'end' ? -metrics.advanceMm : 0;
  const dy = text.baseline === 'top' ? -bounds.top : text.baseline === 'bottom' ? -bounds.bottom
    : text.baseline === 'middle' ? -(bounds.top + bounds.bottom) / 2 : 0;
  return `translate(${position}) rotate(${number(text.angle * 180 / Math.PI)}) translate(${number(dx)} ${number(dy)})`;
}

function primitiveBody(primitive: RenderPrimitive, textMode: 'outline' | 'semantic'): string | null {
  if (primitive.kind === 'text') {
    const content = xml(primitive.text);
    const fill = paint(primitive.fill);
    const transform = textPlacement(primitive);
    if (content === null || fill === null || transform === null) return null;
    if (textMode === 'outline') {
      if (primitive.outline === null) return null;
      const data = pathData(primitive.outline);
      return data === null ? null
        : `<g transform="${transform}" aria-label="${content}"><path d="${data}" fill="${fill}" fill-rule="nonzero"/></g>`;
    }
    const fontId = xml(primitive.metrics.fontId);
    if (fontId === null) return null;
    // ルートのY反転を字形だけで戻す。字体のURLやCSSのimportは埋め込まない。
    return `<g transform="${transform}"><text transform="scale(1 -1)" font-size="${number(primitive.metrics.sizeMm)}" data-font-id="${fontId}" fill="${fill}">${content}</text></g>`;
  }
  const data = pathData(primitive.subpaths);
  const fill = primitive.fill === null ? 'none' : paint(primitive.fill);
  if (data === null || fill === null || (primitive.fillRule !== 'nonzero' && primitive.fillRule !== 'evenodd')) return null;
  let stroke = 'stroke="none"';
  if (primitive.stroke !== null) {
    const spec = primitive.stroke;
    const color = paint(spec.color);
    if (color === null || !Number.isFinite(spec.widthMm) || spec.widthMm < 0
      || spec.dashMm.some((dash) => !Number.isFinite(dash) || dash < 0)) return null;
    stroke = `stroke="${color}" stroke-width="${number(spec.widthMm)}"`;
    if (spec.dashMm.length > 0) stroke += ` stroke-dasharray="${spec.dashMm.map(number).join(' ')}"`;
  }
  return `<path d="${data}" fill="${fill}" fill-rule="${primitive.fillRule}" ${stroke}/>`;
}

/** 用紙mmの中間表現を、外部資源に依存しないSVGへ写す(P8-43)。 */
export function toSvg(document: RenderDocument, options: SvgOptions = {}): string | null {
  if (![document.widthMm, document.heightMm].every((size) => Number.isFinite(size) && size > 0)) return null;
  const definitions: string[] = [];
  const elements: string[] = [];
  for (const [index, primitive] of document.primitives.entries()) {
    const owner = xml(primitive.ownerId);
    const layer = xml(primitive.layerId);
    const transform = matrix(primitive.transform);
    const body = primitiveBody(primitive, options.textMode ?? 'outline');
    if (owner === null || layer === null || transform === null || body === null) return null;
    let clip = '';
    if (primitive.clip !== null) {
      const data = pathData(primitive.clip.subpaths);
      const clipTransform = matrix(primitive.clip.transform);
      if (data === null || clipTransform === null
        || (primitive.clip.fillRule !== 'nonzero' && primitive.clip.fillRule !== 'evenodd')) return null;
      const id = `pcad-clip-${index}`;
      definitions.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${data}" clip-rule="${primitive.clip.fillRule}" transform="${clipTransform}"/></clipPath>`);
      clip = ` clip-path="url(#${id})"`;
    }
    elements.push(`<g data-owner-id="${owner}" data-layer-id="${layer}" transform="${transform}"${clip}>${body}</g>`);
  }
  const width = number(document.widthMm);
  const height = number(document.heightMm);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n`
    + (definitions.length === 0 ? '' : `<defs>${definitions.join('')}</defs>\n`)
    + `<g transform="translate(0 ${height}) scale(1 -1)">\n${elements.join('\n')}\n</g>\n</svg>\n`;
}
