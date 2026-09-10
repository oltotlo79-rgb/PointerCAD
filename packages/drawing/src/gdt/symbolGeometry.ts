import type { DrawingRenderCurve, DrawingRenderElement } from '../render/renderDrawing.js';
import type { Point2 } from '../types.js';
import type { ToleranceCharacteristic } from './types.js';

export type GdtSymbol = ToleranceCharacteristic | 'diameter' | 'maximum';
export interface GdtSymbolGeometry {
  readonly curves: readonly DrawingRenderCurve[];
  readonly fills: NonNullable<DrawingRenderElement['fills']>;
  readonly bounds: { readonly left: number; readonly right: number; readonly bottom: number; readonly top: number };
}

/** ISO 7083:1983図1〜14・21の格子比率。h=10格子、枠高=2h。字体への依存はない。 */
export function gdtSymbolGeometry(symbol: GdtSymbol, heightMm: number, center: Point2 = [0, 0]): GdtSymbolGeometry | null {
  if (!Number.isFinite(heightMm) || heightMm <= 0 || heightMm > 100 || !center.every(Number.isFinite)) return null;
  const grid = heightMm / 10, curves: DrawingRenderCurve[] = [], fills: NonNullable<DrawingRenderElement['fills']>[number][] = [];
  const at = (x: number, y: number): Point2 => [center[0] + x * grid, center[1] + y * grid];
  const line = (a: Point2, b: Point2): void => { curves.push({ kind: 'segment', from: at(...a), to: at(...b) }); };
  const circle = (radius: number, cy = 0, startAngle = 0, endAngle = 2 * Math.PI): void => {
    curves.push({ kind: 'arc', center: at(0, cy), radius: radius * grid, startAngle, endAngle });
  };
  const runout = (x: number): void => {
    line([x - 2.5, -7], [x + 2.5, 7]);
    const tip = at(x + 2.5, 7), left = at(x - 1, 2), right = at(x + 2.5, 0.8);
    fills.push({ fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: tip }, { kind: 'L', to: left }, { kind: 'L', to: right }, { kind: 'Z' }] }] });
  };
  switch (symbol) {
    case 'straightness': line([-7, 0], [7, 0]); break;
    case 'flatness': curves.push({ kind: 'polyline', points: [at(-7, -5), at(3, -5), at(7, 5), at(-3, 5)], closed: true }); break;
    case 'roundness': circle(7); break;
    case 'cylindricity': circle(4); line([-7, -7], [-2, 7]); line([2, -7], [7, 7]); break;
    case 'lineProfile': circle(7, -2.5, 0, Math.PI); break;
    case 'surfaceProfile': circle(7, -2.5, 0, Math.PI); line([-7, -2.5], [7, -2.5]); break;
    case 'parallelism': line([-5.5, -7], [-0.5, 7]); line([0.5, -7], [5.5, 7]); break;
    case 'perpendicularity': line([-7, -7], [7, -7]); line([0, -7], [0, 7]); break;
    case 'angularity': line([-7, -7], [7, -7]); line([-7, -7], [7, 7]); break;
    case 'position': circle(4); line([-7, 0], [7, 0]); line([0, -7], [0, 7]); break;
    case 'coaxiality': circle(7); circle(4); break;
    case 'symmetry': line([-7, 0], [7, 0]); line([-4, 4], [4, 4]); line([-4, -4], [4, -4]); break;
    case 'circularRunout': runout(0); break;
    case 'totalRunout': runout(-4); runout(4); line([-6.5, -7], [1.5, -7]); break;
    case 'diameter': circle(5); line([-7, -7], [7, 7]); break;
    case 'maximum': circle(7); curves.push({ kind: 'polyline', points: [at(-3.5, -5), at(-3.5, 5), at(0, -1), at(3.5, 5), at(3.5, -5)], closed: false }); break;
    default: return null;
  }
  const bounds = { left: center[0] - 7 * grid, right: center[0] + 7 * grid, bottom: center[1] - 7 * grid, top: center[1] + 7 * grid };
  return Object.values(bounds).every(Number.isFinite) ? { curves, fills, bounds } : null;
}
