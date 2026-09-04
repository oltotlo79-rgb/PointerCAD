import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import type { OcctEdgeHandle } from './makeSketchEdges.js';

/**
 * 楕円・楕円弧の位置と大きさ(FR-318)。
 * gp_Ax2(中心・法線・第1軸)で向きを決める点は makeArcEdge(makeSketchEdges.ts)の円と同じ。
 */
export interface EllipseSpec {
  readonly center: Vec3Tuple;
  readonly normal: Vec3Tuple;
  /** 長軸方向(単位ベクトル、normal に直交)。角度 0 はこの向きになる。 */
  readonly majorAxis: Vec3Tuple;
  readonly majorRadius: number;
  readonly minorRadius: number;
  /**
   * ラジアン。startAngle・endAngle の両方を指定すると楕円弧、
   * どちらか一方でも省略すると全周の楕円になる(片方だけの指定は認めない設計で、
   * 呼び出し側の書き漏らしを「全周のつもりが弧になる」事故ではなく「弧のつもりが
   * 全周になる」目立つ形の事故にとどめる)。
   *
   * **注意(2026-09-04 実測、計画書 §1.4-8・§6.8-2 の確認事項への回答)**:
   * この角度は BRepBuilderAPI_MakeEdge_13 = gp_Elips の径数方程式
   * P(u) = center + majorRadius·cos(u)·majorAxis + minorRadius·sin(u)·(normal×majorAxis)
   * の **パラメータ角(離心近点角)** であり、中心から見た **幾何的な方位角とは一致しない**。
   * 一致するのは u = 0, π/2, π, 3π/2 の 4 点だけ。
   * 実測(長軸20・短軸10、Node 上で BRepAdaptor_Curve の Value() を直接読んだ):
   *   u=0      → (20, 0)       (方位角 0° の点と一致)
   *   u=π/4    → (14.142, 7.071)  (方位角45°の真の点は (8.944, 8.944) で不一致)
   *   u=π/2    → (0, 10)       (方位角90°の点と一致)
   * 円弧(gp_Circ、makeArcEdge)は両者が常に一致するため、円弧からの類推で
   * この角度を「見た目の角度」と誤解しないこと。GC_MakeArcOfEllipse も同じ
   * パラメータ角の Alpha を使うため、切り替えても解消しない(型定義で実在は確認済み、
   * 挙動は gp_Elips の径数方程式に基づくため未実行で判断できる)。
   * 幾何的な方位角で指定したい場合の変換式は、呼び出し側(model 層)の責務とする。
   */
  readonly startAngle?: number;
  readonly endAngle?: number;
}

/**
 * 楕円・楕円弧の稜線を作る(FR-318)。
 *
 * gp_Ax2_2(center, normal, majorAxis) → gp_Elips_2(axis, majorRadius, minorRadius) →
 * 角度が両方指定されていれば BRepBuilderAPI_MakeEdge_13、無ければ全周の
 * BRepBuilderAPI_MakeEdge_12。makeArcEdge(makeSketchEdges.ts)の円の作り方をそのまま
 * 楕円へ踏襲した(docs/報告記録.md 2026-09-02 18:23)。
 *
 * 成否の判定に Error() の列挙値を使わないのは、opencascade.js の型定義で
 * BRepBuilderAPI_EdgeError の各値が空の型 `{}` になっており、比較には強制変換が
 * 要るため(makeSketchEdges.ts / makePlanarFace.ts と同じ理由)。IsDone() は
 * boolean なのでそのまま使える。
 */
export function makeEllipseEdge(oc: OpenCascadeInstance, spec: EllipseSpec): OcctEdgeHandle {
  if (!(spec.majorRadius > 0)) {
    throw new Error(`楕円の長軸の半径は正の数である必要があります: ${String(spec.majorRadius)}`);
  }
  if (!(spec.minorRadius > 0)) {
    throw new Error(`楕円の短軸の半径は正の数である必要があります: ${String(spec.minorRadius)}`);
  }
  if (spec.majorRadius < spec.minorRadius) {
    throw new Error(
      `長軸の半径は短軸の半径より大きくしてください(長軸: ${String(spec.majorRadius)}、短軸: ${String(spec.minorRadius)})。`,
    );
  }

  const center = new oc.gp_Pnt_3(spec.center[0], spec.center[1], spec.center[2]);
  const normal = new oc.gp_Dir_4(spec.normal[0], spec.normal[1], spec.normal[2]);
  const majorAxis = new oc.gp_Dir_4(spec.majorAxis[0], spec.majorAxis[1], spec.majorAxis[2]);
  const axis = new oc.gp_Ax2_2(center, normal, majorAxis);
  const elips = new oc.gp_Elips_2(axis, spec.majorRadius, spec.minorRadius);

  // TypeScript の絞り込みは条件式そのものに掛かるため、真偽値へ一度受けずに
  // 三項演算子の条件へ直接書く(受けると startAngle/endAngle が number | undefined のまま残る)。
  const maker =
    spec.startAngle !== undefined && spec.endAngle !== undefined
      ? new oc.BRepBuilderAPI_MakeEdge_13(elips, spec.startAngle, spec.endAngle)
      : new oc.BRepBuilderAPI_MakeEdge_12(elips);

  const cleanup = (): void => {
    maker.delete();
    elips.delete();
    axis.delete();
    majorAxis.delete();
    normal.delete();
    center.delete();
  };

  if (!maker.IsDone()) {
    cleanup();
    throw new Error('楕円の稜線を作れませんでした。半径か角度を確かめてください。');
  }
  const edge = maker.Edge();
  return {
    edge,
    delete(): void {
      edge.delete();
      cleanup();
    },
  };
}
