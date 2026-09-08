import type { Point2 } from '../types.js';

/** 2D のアフィン変換 `[a,b,c,d,e,f]`。 */
export type AffineTransform2 = readonly [number, number, number, number, number, number];

/** 複合パスを失わず各出力へ渡す命令(§2.9)。 */
export type PathCommand =
  | { readonly kind: 'M'; readonly to: Point2 }
  | { readonly kind: 'L'; readonly to: Point2 }
  | {
      readonly kind: 'C';
      readonly control1: Point2;
      readonly control2: Point2;
      readonly to: Point2;
    }
  | { readonly kind: 'Z' };

/** 1 本の subpath。複数を 1 path にまとめることで穴を表せる。 */
export interface RenderSubpath {
  readonly commands: readonly PathCommand[];
}

export interface RenderStroke {
  readonly color: string;
  readonly widthMm: number;
  readonly dashMm: readonly number[];
}

export interface RenderClip {
  readonly subpaths: readonly RenderSubpath[];
  readonly fillRule: 'nonzero' | 'evenodd';
  readonly transform: AffineTransform2;
}

/** 所有者とレイヤーを必ず持つ出力共通のパス。 */
export interface RenderPath {
  readonly kind: 'path';
  readonly subpaths: readonly RenderSubpath[];
  readonly fillRule: 'nonzero' | 'evenodd';
  readonly stroke: RenderStroke | null;
  readonly fill: string | null;
  readonly clip: RenderClip | null;
  readonly transform: AffineTransform2;
  readonly ownerId: string;
  readonly layerId: string;
}

export interface InkBounds {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

/** 同じ実測値で画面・PDF・SVGの文字を配置する契約(§2.9)。 */
export interface SemanticTextMetrics {
  readonly fontId: string;
  readonly sizeMm: number;
  readonly advanceMm: number;
  readonly inkBounds: InkBounds;
}

export interface RenderText {
  readonly kind: 'text';
  readonly text: string;
  readonly position: Point2;
  readonly angle: number;
  readonly anchor: 'start' | 'middle' | 'end';
  readonly baseline: 'top' | 'middle' | 'bottom' | 'alphabetic';
  readonly metrics: SemanticTextMetrics;
  readonly outline: readonly RenderSubpath[] | null;
  readonly fill: string;
  readonly clip: RenderClip | null;
  readonly transform: AffineTransform2;
  readonly ownerId: string;
  readonly layerId: string;
}

export type RenderPrimitive = RenderPath | RenderText;

/** 用紙 1 枚ぶんを 4 つの出口へ渡す中間表現(§0.31、§2.9)。 */
export interface RenderDocument {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly primitives: readonly RenderPrimitive[];
}
