/**
 * ばね(コイルばね、FR-414、計画書 P3 §2.7b.4、タスク9b)。
 *
 * らせんの掃引路(makeHelix.ts、ねじの実らせんと共用)を、円形の断面(線材の太さ)で
 * 掃引して作る。**対象を取らず、新しい形を作る**(§0.36。押し出し・回転・縫合と同じ
 * 「作る」フィーチャーで、パターンの対象にもしない)。
 *
 * **掃引の向きの指定(§1.4-11 の実測、2026-09-04 に Node で確認)。**
 * D20/d2/p5/n4(コイル径20・線径2・ピッチ5・巻数4)で 3 通りを比べた(一時的な
 * 実測ファイルで確認。結果はここへ記録し、実測ファイルは削除した)。
 *
 * | 指定 | 体積(mm³) | 計算値 792.064406711 との相対誤差 |
 * |---|---|---|
 * | `SetMode_1(true)`(Frenet、採用) | 792.064607 | 0.0000% |
 * | `SetMode_2(gp_Ax2(始点, 軸))`(軸に固定した平面) | 4.984249 | **99.3707%(壊れる)** |
 * | `SetMode_3(gp_Dir(軸))`(副法線を軸へ固定) | 792.064631 | 0.0000% |
 *
 * **`SetMode_2` は使えない。** 断面の向きを空間に固定した平面へ縛ると、らせんが
 * 軸のまわりを回るにつれて断面が経路の接線に対して大きく傾き、掃引が自己交差した
 * ほぼ潰れた形になる(体積が計算値の 5mm³ ほどにしかならない)。
 * `SetMode_1`(Frenet)と `SetMode_3`(副法線を軸へ固定)はどちらも正しい体積になる
 * ——円の断面は接線まわりにどれだけ回っても同じ円のままなので、経路の接線に
 * 垂直な向きを保つ指定であればどちらでも成り立つ。**ここでは意味の読める
 * `SetMode_1(true)`(Frenet、法線面を保つ)を採る**(計画書の推奨どおり)。
 *
 * **体積・所要の実測(makeSpring.test.ts に検査として残す。§2.7b.5 の検算表 5 点):**
 * 計算値との相対誤差はすべて 0.0000%〜0.0002% ほど(掃引を B スプラインで
 * 近似する誤差、許容 0.5% に対して十分小さい)。巻数 4(D20/d2/p5)の所要は
 * 実測 200ms 前後で NFR-PF-2(500ms)に収まる。巻数 20 / 100 の所要は
 * makeSpring.test.ts が実測してログに残す(§0.35。上限は無く実測を報告するだけ)。
 */

import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import type { SpringStepSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { helixStartFrame, makeHelixWire, type HelixSpec } from './makeHelix.js';
import type { OcctShapeHandle } from './makeBox.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

/** 巻数の上限(§0.a-0.35)。 */
const MAX_TURNS = 200;

/** これ未満の体積(mm³)は「立体にならなかった」とみなす(他の make*.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

const COIL_DIAMETER_MESSAGE = 'コイル径は 0 より大きい数にしてください。';
const WIRE_DIAMETER_MESSAGE = '線径は 0 より大きい数にしてください。';
const WIRE_TOO_LARGE_MESSAGE = '線径はコイル径より小さくしてください。';
const PITCH_MESSAGE = 'ピッチは 0 より大きい数にしてください。';
const TURNS_MESSAGE = '巻数は 0 より大きく 200 以下にしてください。';

/** 隣り合う巻きの線材が交差するとき(§2.7b.4)。実行する前に断る(NFR-UX-5)。 */
const PITCH_TOO_SMALL_MESSAGE = 'ピッチは線径より大きくしてください。隣どうしの線がぶつかります。';

/** 軸の向きが決まらないとき(長さ 0・非数)。 */
const AXIS_MESSAGE = 'ばねの軸の向きが決まりません。向きを選び直してください。';

/** 掃引が成立しなかったとき。 */
const SWEEP_FAILED_MESSAGE = 'ばねの形を作れませんでした。コイル径・線径・ピッチを見直してください。';

/** 掃引はできたが、結果が立体になっていないとき。 */
const NOT_SOLID_MESSAGE = 'ばねが立体になりませんでした。線径を小さくするか、ピッチを大きくしてください。';

/** 長さが取れない(0・非数)ときは null。makeHelix.ts の toUnit と同じ考え。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const size = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return [value[0] / size, value[1] / size, value[2] / size];
}

/** 値を確かめる。断るときは日本語の Error(§2.7b.4 の断り方の表)。 */
function checkSpringSpec(spec: SpringStepSpec): void {
  if (!Number.isFinite(spec.coilDiameter) || spec.coilDiameter <= 0) {
    throw new Error(COIL_DIAMETER_MESSAGE);
  }
  if (!Number.isFinite(spec.wireDiameter) || spec.wireDiameter <= 0) {
    throw new Error(WIRE_DIAMETER_MESSAGE);
  }
  if (spec.wireDiameter >= spec.coilDiameter) {
    throw new Error(WIRE_TOO_LARGE_MESSAGE);
  }
  if (!Number.isFinite(spec.pitch) || spec.pitch <= 0) {
    throw new Error(PITCH_MESSAGE);
  }
  if (!Number.isFinite(spec.turns) || spec.turns <= 0 || spec.turns > MAX_TURNS) {
    throw new Error(TURNS_MESSAGE);
  }
  if (spec.pitch <= spec.wireDiameter) {
    throw new Error(PITCH_TOO_SMALL_MESSAGE);
  }
  if (toUnit(spec.direction) === null) {
    throw new Error(AXIS_MESSAGE);
  }
}

/** SpringStepSpec を、makeHelix.ts が受け取る HelixSpec へ詰め替える。掃引路の半径はコイル半径。 */
function toHelixSpec(spec: SpringStepSpec): HelixSpec {
  return {
    origin: spec.origin,
    direction: spec.direction,
    radius: spec.coilDiameter / 2,
    pitch: spec.pitch,
    turns: spec.turns,
    handedness: spec.handedness,
  };
}

/**
 * ばねの断面(円)のワイヤ。始点に中心があり、接線に垂直な向きに置く(§2.7b.4)。
 * 確保したものは keep へ積む(呼び出し側がまとめて解放する)。
 */
export function makeSpringProfile(
  oc: OpenCascadeInstance,
  point: Vec3Tuple,
  tangent: Vec3Tuple,
  wireDiameter: number,
  keep: Allocations['keep'],
): TopoDS_Wire {
  const centre = keep(new oc.gp_Pnt_3(point[0], point[1], point[2]));
  const normal = keep(new oc.gp_Dir_4(tangent[0], tangent[1], tangent[2]));
  // gp_Ax2_3(P, V) は第 1 軸を OCCT に任せる版(2 引数)。断面は円で軸対称なので
  // 第 1 軸をどちらへ向けても同じ形になり、ねじ(makeThread.ts)のように
  // 自分で第 1 軸を決める必要が無い。
  const axes = keep(new oc.gp_Ax2_3(centre, normal));
  const circle = keep(new oc.gp_Circ_2(axes, wireDiameter / 2));
  const edgeMaker = keep(new oc.BRepBuilderAPI_MakeEdge_8(circle));
  if (!edgeMaker.IsDone()) {
    throw new Error(SWEEP_FAILED_MESSAGE);
  }
  const edge = keep(edgeMaker.Edge());
  const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_2(edge));
  if (!wireMaker.IsDone()) {
    throw new Error(SWEEP_FAILED_MESSAGE);
  }
  return keep(wireMaker.Wire());
}

/**
 * ばね(FR-414)。対象を取らず、新しい形を作る(§0.36)。
 *
 * 手順は計画書 §2.7b.4 のとおり: ①値の検査 → ②`makeHelixWire` で掃引路 →
 * ③`helixStartFrame` で始点と接線を取り `makeSpringProfile` で断面 →
 * ④`BRepOffsetAPI_MakePipeShell` で掃引 → ⑤`MakeSolid()` が false ならソリッドで包む →
 * ⑥`isValidShape` / `hasSolid` / 体積 0 の検査。
 *
 * 計画書の見出しは `options?: TessellationOptions` を持つが、掃引そのものは
 * テッセレーションの粗さを使わないので受け取らない(`makeHole.ts` が
 * `options` を未使用引数として外したのと同じ判断。2026-09-04 引き継ぎ時の統括メモ参照)。
 */
export function makeSpring(oc: OpenCascadeInstance, spec: SpringStepSpec): OcctShapeHandle {
  checkSpringSpec(spec);

  const { keep, release } = createAllocations();
  try {
    const helixSpec = toHelixSpec(spec);
    const spine = makeHelixWire(oc, helixSpec, keep);
    const { point, tangent } = helixStartFrame(helixSpec);
    const profile = makeSpringProfile(oc, point, tangent, spec.wireDiameter, keep);

    const pipe = keep(new oc.BRepOffsetAPI_MakePipeShell(spine));
    // Frenet(法線面を保つ)。SetMode_3(副法線を軸へ固定)でも同じ体積になるが、
    // SetMode_2(軸に固定した平面)は断面が接線から大きく傾いて自己交差した
    // ほぼ潰れた形になる(このファイル冒頭の注釈、§1.4-11 の実測)。
    pipe.SetMode_1(true);
    // 断面はすでに正しい位置と向きにあるので補正しない(makeSpringProfile が
    // 接線に垂直な向きへ置いている)。
    pipe.Add_1(profile, false, false);
    if (!pipe.IsReady()) {
      throw new Error(SWEEP_FAILED_MESSAGE);
    }
    pipe.Build(keep(new oc.Message_ProgressRange_1()));
    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ
    // (docs/報告記録.md 2026-09-03 06:56 の⑤。makeThread.ts と同じ扱い)。
    if (!pipe.IsDone()) {
      throw new Error(SWEEP_FAILED_MESSAGE);
    }

    let shape: TopoDS_Shape;
    if (pipe.MakeSolid()) {
      shape = keep(pipe.Shape());
    } else {
      // 掃引した殻が閉じていなかったとき(§1.4-5)。殻をソリッドで包む。
      const shell = keep(oc.TopoDS.Shell_1(keep(pipe.Shape())));
      const solidMaker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell));
      if (!solidMaker.IsDone()) {
        throw new Error(SWEEP_FAILED_MESSAGE);
      }
      shape = keep(solidMaker.Shape());
    }

    if (!hasSolid(oc, shape) || Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME_MM3) {
      throw new Error(NOT_SOLID_MESSAGE);
    }
    if (!isValidShape(oc, shape)) {
      throw new Error(NOT_SOLID_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    // OCCT の C++ 例外は数値で飛んでくる(makeFillet.ts / makeThread.ts と同じ)。
    throw error instanceof Error ? error : new Error(SWEEP_FAILED_MESSAGE);
  }
}
