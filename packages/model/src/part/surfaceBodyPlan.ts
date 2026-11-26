import type { BlendSurfaceError, EdgeDistanceHoleReason, HoleFailureCode, SewFacesReason, SurfaceThickenError } from '@pointercad/kernel';
import type { SubShapeRef, SurfaceCutFailureReason, ThickenFeature } from './types.js';

/** 入力ボディを指す鍵と、式を評価した後の寸法 (mm)。 */
export interface ThickenPlan {
  readonly kind: 'thicken';
  readonly targetKey: string;
  readonly thickness: number;
  readonly side: ThickenFeature['side'];
}

export interface OffsetBodyPlan {
  readonly kind: 'offsetBody';
  readonly targetKey: string;
  readonly distance: number;
}

interface BlendBoundary<Query> {
  readonly sourceKey: string;
  readonly query: Query;
}

/** 両側の境界辺を貸す段と、評価済みの横接線の長さ (mm)。 */
export interface BlendPlan<Query = SubShapeRef> {
  readonly kind: 'blend';
  readonly a: BlendBoundary<Query>;
  readonly b: BlendBoundary<Query>;
  readonly weightA: number;
  readonly weightB: number;
  readonly flipB: boolean;
}

/** 面だけのボディの機能(厚み付け・面全体のオフセット・つなぎ面)の失敗の符号。画面の側の文の一覧(ui/src/solid/surfaceBodyFailureText.ts)の鍵。 */
export type SurfaceBodyFailureReason = SurfaceThickenError['code'] | BlendSurfaceError['code'] | 'outside-tolerance';

/** 計算部が返す立体の失敗の符号の全部。画面の側の文の一覧(ui/src/solid/surfaceBodyFailureText.ts)の鍵(0b-2 で面の縫い合わせ・辺からの距離の穴を足した)。 */
export type SolidFailureReason = SurfaceCutFailureReason | SurfaceBodyFailureReason | SewFacesReason | EdgeDistanceHoleReason | HoleFailureCode;
