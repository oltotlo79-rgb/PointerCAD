import type { Point2 } from '../types.js';
import type { InkBounds, PathCommand, RenderSubpath } from '../render/types.js';
import { cubicBezierPoint } from '../render/bezierArc.js';

/** opentype.jsの公開getPath命令。2次曲線は出口を分けずここで3次へ持ち上げる。 */
export type GlyphPathCommand =
  | { readonly type: 'M'; readonly x: number; readonly y: number }
  | { readonly type: 'L'; readonly x: number; readonly y: number }
  | { readonly type: 'Q'; readonly x1: number; readonly y1: number; readonly x: number; readonly y: number }
  | { readonly type: 'C'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly type: 'Z' };

export interface TextOutlineGeometry {
  readonly subpaths: readonly RenderSubpath[];
  readonly fillRule: 'nonzero';
  readonly inkBounds: InkBounds;
}

/** 微小な係数を閾値で消さず、0<t<1の極値だけを返す。 */
function extrema(p0: number, p1: number, p2: number, p3: number): readonly number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  if (a === 0) return b === 0 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
  return q === 0 ? [-b / (2 * a)] : [q / a, c / q];
}

export function outlineInkBounds(subpaths: readonly RenderSubpath[]): InkBounds {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  const include = ([x, y]: Point2) => {
    left = Math.min(left, x); bottom = Math.min(bottom, y);
    right = Math.max(right, x); top = Math.max(top, y);
  };
  for (const { commands } of subpaths) {
    let from: Point2 = [0, 0];
    for (const command of commands) {
      if (command.kind === 'Z') continue;
      include(command.to);
      if (command.kind === 'C') {
        const curve = { from, ...command };
        for (const axis of [0, 1]) {
          for (const t of extrema(from[axis], command.control1[axis], command.control2[axis], command.to[axis])) {
            if (t > 0 && t < 1) include(cubicBezierPoint(curve, t));
          }
        }
      }
      from = command.to;
    }
  }
  return left === Infinity ? { left: 0, bottom: 0, right: 0, top: 0 } : { left, bottom, right, top };
}

/** 字体・DOM・カーネルに依存しない変換。opentypeの下向きYを用紙の上向きYへ写す。 */
export function textOutline(commands: readonly GlyphPathCommand[], flipY = true): TextOutlineGeometry | null {
  const subpaths: RenderSubpath[] = [];
  let current: PathCommand[] = [];
  let from: Point2 | null = null;
  const point = (x: number, y: number): Point2 => [x, flipY ? -y : y];
  const close = () => {
    // CFFのgetPathはZを省略することがある。次のMと末尾でも必ず輪を閉じる。
    if (current.length > 1) subpaths.push({ commands: [...current, { kind: 'Z' }] });
    current = []; from = null;
  };
  for (const command of commands) {
    if (command.type === 'Z') { close(); continue; }
    if (!Object.values(command).every((value) => typeof value !== 'number' || Number.isFinite(value))) return null;
    const to = point(command.x, command.y);
    if (command.type === 'M') {
      close(); current.push({ kind: 'M', to });
    } else {
      if (from === null) return null;
      if (command.type === 'L') current.push({ kind: 'L', to });
      else if (command.type === 'C') current.push({ kind: 'C', to,
        control1: point(command.x1, command.y1), control2: point(command.x2, command.y2) });
      else {
        const control = point(command.x1, command.y1);
        current.push({ kind: 'C', to,
          control1: [from[0] + 2 / 3 * (control[0] - from[0]), from[1] + 2 / 3 * (control[1] - from[1])],
          control2: [to[0] + 2 / 3 * (control[0] - to[0]), to[1] + 2 / 3 * (control[1] - to[1])] });
      }
    }
    from = to;
  }
  close();
  const inkBounds = outlineInkBounds(subpaths);
  if (!Object.values(inkBounds).every(Number.isFinite)) return null;
  return { subpaths, fillRule: 'nonzero', inkBounds };
}
