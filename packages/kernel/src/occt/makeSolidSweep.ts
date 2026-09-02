import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { ExtrudeStepSpec, RevolveStepSpec, TessellationOptions, Vec3Tuple } from '../types.js';
import { makePlanarFace } from './makePlanarFace.js';
import { isValidShape, measureVolume } from './solidMesh.js';

/** OCCT の形と、その形を作るために確保した領域の解放手続き(makeBox.ts の OcctShapeHandle と同じ形)。 */
export interface OcctSolidHandle {
  readonly shape: TopoDS_Shape;
  delete(): void;
}

/** OCCT が確保した領域を持ち、まとめて解放できるもの。 */
interface OcctDeletable {
  delete(): void;
}

/**
 * BRepPrimAPI_MakePrism_1 / BRepPrimAPI_MakeRevol_1 の Copy に渡す値。
 *
 * 2026-09-03 に Node で実測(計画書 §1.2 の未確認点 1 の後半):
 *   40 × 30 の断面を 10 押し出したとき Copy=true / false のどちらでも
 *   体積 12000、面 6、稜線 12、妥当性 true で結果が変わらなかった。
 * 断面は毎回この関数の中で作り捨てるので複製する意味が無く、OCCT の C++ 側の
 * 既定値と同じ false を採る。
 */
const SWEEP_COPY = false;

/**
 * BRepPrimAPI_MakePrism_1 の Canonize に渡す値。
 *
 * 2026-09-03 に Node で実測(計画書 §1.2 の未確認点 1):
 *   10 × 10 の正方形を Z へ 5 押し出したとき
 *     Canonize=true  体積 500 / 面 6 / 稜線 12 / 平面 6 枚
 *     Canonize=false 体積 500 / 面 6 / 稜線 12 / 平面 2 枚 + 押し出し曲面 4 枚
 *   体積と面数はどちらも同じで、違うのは側面の下地の曲面だけだった。
 *
 * true を採る。平らな断面を押し出した側面は本来ただの平面であり、
 * 平面として持っておいたほうが後段のブーリアン(タスク5)や面の選択が素直に働くため。
 */
const PRISM_CANONIZE = true;

/**
 * 「厚みが出た」とみなす体積の下限(mm³)。
 * これを下回る形は、押し出しの向きが断面と同じ平面にある、
 * 回転軸が断面の平面に直交している、といった理由で潰れている。
 */
const MIN_SOLID_VOLUME = 1e-9;

/** 回転角の上限(ラジアン)。1 周を超える指定は受け取らない。丸めの揺れぶんだけ余裕を持たせる。 */
const MAX_REVOLVE_ANGLE = 2 * Math.PI + 1e-9;

/** 向きを長さ 1 に揃える。長さが 0 のときや数でないときは null を返す。 */
function normalizeDirection(vector: Vec3Tuple): Vec3Tuple | null {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [x / length, y / length, z / length];
}

/** 3 つとも実数か(NaN と無限大を弾く)。 */
function isFinitePoint(point: Vec3Tuple): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

/**
 * 確保したものを控えておき、作った順の逆にまとめて解放する入れ物。
 *
 * maker.Shape() が返す形は maker の中の実体を指すので、形だけを先に解放できない。
 * 控えへ「面 → ベクトル(軸)→ maker → 形」の順に積み、解放は必ずその逆順で行う
 * (計画書 §1.2 の落とし穴、P0 の makeBox.ts と同じ約束)。
 */
function createAllocations(): {
  keep: <T extends OcctDeletable>(item: T) => T;
  release: () => void;
} {
  const items: OcctDeletable[] = [];
  return {
    keep<T extends OcctDeletable>(item: T): T {
      items.push(item);
      return item;
    },
    release(): void {
      for (let index = items.length - 1; index >= 0; index -= 1) {
        items[index].delete();
      }
      items.length = 0;
    },
  };
}

/**
 * 断面を direction の向きへ distance だけ押し出す(FR-401)。
 *
 * 向きと長さは model 側で決めて渡す約束(計画書 §0.a-0.8)なので、
 * ここでは反転も両側も扱わない。向きは長さ 1 に揃えてから distance を掛ける。
 * 断面が閉じていない・自己交差している・平面に乗っていない場合は
 * makePlanarFace が理由つきで断り、その文言がそのまま呼び出し側へ伝わる。
 */
export function makeExtrudeSolid(
  oc: OpenCascadeInstance,
  spec: ExtrudeStepSpec,
  options: TessellationOptions = {},
): OcctSolidHandle {
  if (!Number.isFinite(spec.distance) || spec.distance <= 0) {
    throw new Error('押し出す長さは 0 より大きい数にしてください。');
  }

  const direction = normalizeDirection(spec.direction);
  if (direction === null) {
    throw new Error('押し出す向きが決まりません。断面が平らかどうかを確かめてください。');
  }

  const { keep, release } = createAllocations();

  try {
    const face = keep(makePlanarFace(oc, spec.profile, options));
    const vector = keep(
      new oc.gp_Vec_4(
        direction[0] * spec.distance,
        direction[1] * spec.distance,
        direction[2] * spec.distance,
      ),
    );
    const maker = keep(new oc.BRepPrimAPI_MakePrism_1(face.face, vector, SWEEP_COPY, PRISM_CANONIZE));

    // 成否は IsDone() だけで見る。Error() の戻り値(BRepBuilderAPI_*Error)は
    // 型定義では空の型 `{}` になっており、比較に強制変換が要るため使わない。
    if (!maker.IsDone()) {
      throw new Error('断面を押し出せませんでした。断面の形を見直してください。');
    }

    const shape = keep(maker.Shape());

    // 断面と同じ平面へ押し出すと OCCT は成功を返すが、体積 0 の潰れた形になる。
    // 面の向きが裏返っている断面では符号が負になり得るので絶対値で見る。
    if (Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME) {
      throw new Error('押し出しても厚みが出ませんでした。長さを大きくしてください。');
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 断面を軸まわりに angle(ラジアン)だけ回す(FR-402)。
 *
 * 角度は必ずラジアンで受け取る。度で受け取ると MakeEdge_9 と同じ取り違えが起きるため、
 * 度からの換算は model 側の責務にしてある(計画書 §0.a-0.9)。
 */
export function makeRevolveSolid(
  oc: OpenCascadeInstance,
  spec: RevolveStepSpec,
  options: TessellationOptions = {},
): OcctSolidHandle {
  if (!Number.isFinite(spec.angle) || spec.angle <= 0 || spec.angle > MAX_REVOLVE_ANGLE) {
    throw new Error('回転の角度は 0 より大きく 360 度以下にしてください。');
  }

  const axisDirection = normalizeDirection(spec.axisDirection);
  if (axisDirection === null || !isFinitePoint(spec.axisOrigin)) {
    throw new Error('回転の軸が決まりません。軸を選び直してください。');
  }

  const { keep, release } = createAllocations();

  try {
    const face = keep(makePlanarFace(oc, spec.profile, options));
    const origin = keep(
      new oc.gp_Pnt_3(spec.axisOrigin[0], spec.axisOrigin[1], spec.axisOrigin[2]),
    );
    const towards = keep(new oc.gp_Dir_4(axisDirection[0], axisDirection[1], axisDirection[2]));
    const axis = keep(new oc.gp_Ax1_2(origin, towards));
    const maker = keep(new oc.BRepPrimAPI_MakeRevol_1(face.face, axis, spec.angle, SWEEP_COPY));

    // 断面が軸をまたいでいると、OCCT は IsDone() に false を返す(2026-09-03 実測)。
    // このとき Shape() を呼ぶと C++ の例外がそのまま飛んでくるので、先に IsDone() を見る。
    if (!maker.IsDone()) {
      throw new Error('断面が回転軸と重なっているため、回せませんでした。断面を軸から離してください。');
    }

    const shape = keep(maker.Shape());

    if (!isValidShape(oc, shape)) {
      throw new Error('断面が回転軸と重なっているため、回せませんでした。断面を軸から離してください。');
    }

    // 軸が断面の平面に直交していると、OCCT は成功を返すが体積 0 の形になる(2026-09-03 実測)。
    if (Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME) {
      throw new Error('回しても厚みが出ませんでした。軸と断面の向きを見直してください。');
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
