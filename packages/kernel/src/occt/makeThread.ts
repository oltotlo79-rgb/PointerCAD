/**
 * ねじ穴(FR-406、計画書 P3 §2.4、タスク9)。
 *
 * 下穴(めねじ内径 D1)は穴(タスク6)とまったく同じ手順で掘り、
 * `spec.thread` が入っているときだけ**実らせんの溝**を切る(§0.a-0.16)。
 * 既定は簡略表示で、そのときは B-rep に触れず `ThreadMarkInfo` を返すだけなので
 * 再計算の費用が下穴 1 本ぶんしかかからない(§0.a-0.15)。
 *
 * **実らせんの所要(2026-09-04 に Node で実測。§1.4-⑥):**
 * M6×1・深さ 10mm(10 巻き)で、掃引そのものは 30〜170ms と安いが、
 * **溝を材料から差し引くブーリアンに 1.5〜1.9 秒かかり、NFR-PF-2(単一フィーチャー
 * 500ms)を超える。** 打ち切るか P5 へ送るかは統括の判断を待つ(§0.a-0.16)ので、
 * ここでは動く形で実装したうえで実測値を報告してある。簡略表示(既定)は 30ms 前後。
 *
 * **工具の組み立て方(2026-09-04 実測に基づく重要な決め):**
 * 下穴の円柱と溝は重なり合う。**重なり合う形を 1 つのコンパウンドへ入れて
 * ブーリアンの工具に渡すと、OCCT は例外も出さずに「何も削れなかった」結果を返す**
 * (実測: 板 12000 に対し結果も 12000)。また「下穴を掘った形から溝を引く」2 段構えは
 * 2 巻きでは通るが 10 巻きでは同じく黙って何も削れなかった(2.1 秒かけて結果が変わらない)。
 * そこで**先に円柱と溝を和(Fuse)で 1 つにまとめ、それを 1 回で差し引く**。
 * 4 通りの条件すべてで正しい体積が出た唯一の手である。
 */

import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import type {
  RigidTransformSpec,
  SolidFaceInfo,
  ThreadCutSpec,
  ThreadMarkInfo,
  ThreadStepSpec,
  Vec3Tuple,
} from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { helixAxisFrame, makeHelixWire } from './makeHelix.js';
import { makeHoleTools, resolveHoleFrame } from './makeHole.js';
import { measureVolume } from './solidMesh.js';
import {
  applyTransformToDirection,
  applyTransformToPoint,
  isIdentityTransform,
  makeCompound,
  transformShape,
  transformsOrIdentity,
} from './transformShape.js';

/** ピッチが 0 以下・非数のとき。 */
const PITCH_MESSAGE = 'ねじのピッチは 0 より大きい数にしてください。';

/** 外径が下穴径以下のとき(溝を切る場所が無い)。 */
const MAJOR_DIAMETER_MESSAGE = 'ねじの外径は下穴の径より大きくしてください。';

/** ねじ部の長さが 0 以下・非数のとき。 */
const THREAD_LENGTH_MESSAGE = 'ねじ部の長さは 0 より大きい数にしてください。';

/** 掃引が成立しなかったとき。簡略表示なら必ず作れるので、そちらへ逃がす案内を添える。 */
const SWEEP_FAILED_MESSAGE = 'ねじの形を作れませんでした。簡略表示に切り替えてお試しください。';

/** ブーリアンそのものが成立しなかったとき。 */
const THREAD_FAILED_MESSAGE = 'ねじ穴をあけられませんでした。位置や径を見直してください。';

/** 対象が丸ごと削れてしまったとき。 */
const NOTHING_LEFT_MESSAGE =
  'ねじ穴をあけたら立体が残りませんでした。呼び径か深さを小さくしてください。';

/** 削れた量が 0 だったとき(中心が材料から外れている)。makeHole.ts と同じ考え。 */
const NOTHING_REMOVED_MESSAGE =
  'ねじ穴が材料に当たりませんでした。中心の位置や向きを見直してください。';

/** これ未満(mm³)しか削れていなければ「何も削れなかった」とみなす(makeHole.ts と同じ)。 */
const MIN_REMOVED_VOLUME_MM3 = 1e-9;

/**
 * 溝の断面(二等辺三角形)の底辺の幅を、ピッチの何倍にするか。
 *
 * 基本山形(ISO 68-1)では、めねじの谷(材料が削られる側)の開き口は
 * 内径 D1 のところで **3P/4** になる(めねじの山の頂は幅 P/4 の平らな面になるため)。
 * その値をそのまま採ると、隣り合う巻きの断面のあいだに P/4 の隙間が残り、
 * **掃引した溝が自分自身と接しない**。ピッチと同じ幅(鋭い山)にすると
 * 隣の巻きと角どうしが触れ合い、ブーリアンが不安定になる。
 */
const PROFILE_BASE_RATIO = 0.75;

/**
 * 溝の断面を、下穴の壁より内側へどれだけ食い込ませるか(山の高さに対する割合)。
 *
 * 断面の底辺を下穴の円筒面にぴったり合わせると、工具どうしが面で接する形になり、
 * OCCT のブーリアンが最も苦手とする配置になる(貫通穴の margin と同じ理屈、§0.a-0.12)。
 * 2026-09-04 の実測でも、食い込ませない(0)ほうが 3 倍以上遅かった
 * (10 巻きで和が 5.4 秒 対 1.5 秒)。食い込ませたぶんは下穴の中の空所なので、
 * 出来上がる形は変わらない。
 */
const PROFILE_INSET_RATIO = 0.25;

/** 掃引路(らせん)の半径。山と谷の中間(§2.4.2 の手順 12)。 */
export function threadSweepRadius(majorDiameter: number, drillDiameter: number): number {
  return (majorDiameter + drillDiameter) / 4;
}

/** ねじの値を確かめる。断るときは日本語の Error(FR-504)。 */
function checkThreadSpec(spec: ThreadCutSpec, drillDiameter: number): void {
  if (!Number.isFinite(spec.pitch) || spec.pitch <= 0) {
    throw new Error(PITCH_MESSAGE);
  }
  if (
    !Number.isFinite(spec.majorDiameter) ||
    !Number.isFinite(drillDiameter) ||
    spec.majorDiameter <= drillDiameter
  ) {
    throw new Error(MAJOR_DIAMETER_MESSAGE);
  }
  if (!Number.isFinite(spec.length) || spec.length <= 0) {
    throw new Error(THREAD_LENGTH_MESSAGE);
  }
}

/**
 * 溝の断面(二等辺三角形)のワイヤを作る。
 *
 * **軸を含む平面の上**に置く。山の頂点は外径 d の位置(材料の奥)、底辺は下穴の壁より
 * すこし内側で、軸方向にピッチの 3/4 の幅を持つ。掃引の始点(らせんの u = 0 の点)を
 * 基準にするので、`makeHelixWire` が作る掃引路とぴったり噛み合う。
 */
function makeThreadProfile(
  oc: OpenCascadeInstance,
  origin: Vec3Tuple,
  direction: Vec3Tuple,
  spec: ThreadCutSpec,
  drillDiameter: number,
  keep: Allocations['keep'],
): TopoDS_Wire {
  const frame = helixAxisFrame(direction);
  if (frame === null) {
    throw new Error(SWEEP_FAILED_MESSAGE);
  }
  const { xAxis, zAxis } = frame;
  const sweepRadius = threadSweepRadius(spec.majorDiameter, drillDiameter);
  const crestHeight = (spec.majorDiameter - drillDiameter) / 2;
  // 掃引路の上の点(らせんの始点)からの、半径方向・軸方向のずれで断面を書く。
  const outward = spec.majorDiameter / 2 - sweepRadius;
  const inward = drillDiameter / 2 - crestHeight * PROFILE_INSET_RATIO - sweepRadius;
  const half = (spec.pitch * PROFILE_BASE_RATIO) / 2;

  const at = (radial: number, along: number): Vec3Tuple => [
    origin[0] + (sweepRadius + radial) * xAxis[0] + along * zAxis[0],
    origin[1] + (sweepRadius + radial) * xAxis[1] + along * zAxis[1],
    origin[2] + (sweepRadius + radial) * xAxis[2] + along * zAxis[2],
  ];
  const corners: readonly Vec3Tuple[] = [at(outward, 0), at(inward, -half), at(inward, half)];

  const points = corners.map((corner) => keep(new oc.gp_Pnt_3(corner[0], corner[1], corner[2])));
  const maker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  for (let index = 0; index < points.length; index += 1) {
    const edgeMaker = keep(
      new oc.BRepBuilderAPI_MakeEdge_3(points[index], points[(index + 1) % points.length]),
    );
    if (!edgeMaker.IsDone()) {
      throw new Error(SWEEP_FAILED_MESSAGE);
    }
    maker.Add_1(keep(edgeMaker.Edge()));
  }
  if (!maker.IsDone()) {
    throw new Error(SWEEP_FAILED_MESSAGE);
  }
  return keep(maker.Wire());
}

/**
 * ねじ 1 本ぶんの実らせん(掃引した溝)。簡略表示のときは呼ばない。
 *
 * `origin` は下穴の口(ねじの切り始め)、`direction` は掘り進む向き。
 * **巻き方向は常に右**である(JIS のメートルねじは右ねじ。左ねじは P5 以降)。
 *
 * 返した handle の delete() で、掃引路・断面・掃引の maker と結果の形をまとめて解放する。
 */
export function makeThreadCut(
  oc: OpenCascadeInstance,
  origin: Vec3Tuple,
  direction: Vec3Tuple,
  spec: ThreadCutSpec,
  drillDiameter: number,
): OcctShapeHandle {
  checkThreadSpec(spec, drillDiameter);

  const { keep, release } = createAllocations();
  try {
    const spine = makeHelixWire(
      oc,
      {
        origin,
        direction,
        radius: threadSweepRadius(spec.majorDiameter, drillDiameter),
        pitch: spec.pitch,
        turns: spec.length / spec.pitch,
        handedness: 'right',
      },
      keep,
    );
    const profile = makeThreadProfile(oc, origin, direction, spec, drillDiameter, keep);

    const pipe = keep(new oc.BRepOffsetAPI_MakePipeShell(spine));
    // 掃引の向きは「軸を副法線に固定」(§2.4.2 の手順 15)。断面はすでに軸を含む面の上に
    // 正しく置いてあるので、Add_1 の補正(第 3 引数)は行わない。
    // 2026-09-04 実測: SetMode_1(Frenet)でも溝の体積は同じ(40.6340mm³)だったが、
    // ねじは軸まわりの形なので意味の読める SetMode_3 を採る。
    pipe.SetMode_3(keep(new oc.gp_Dir_4(direction[0], direction[1], direction[2])));
    pipe.Add_1(profile, false, false);
    if (!pipe.IsReady()) {
      throw new Error(SWEEP_FAILED_MESSAGE);
    }
    pipe.Build(keep(new oc.Message_ProgressRange_1()));
    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ(docs/報告記録.md 2026-09-03 06:56 の⑤)。
    if (!pipe.IsDone()) {
      throw new Error(SWEEP_FAILED_MESSAGE);
    }
    // 2026-09-04 実測(§1.4-⑤): 掃引した殻は閉じており MakeSolid() は true を返し、
    // Shape() は SOLID になった。false になったときのために殻を包む道は残しておく。
    if (!pipe.MakeSolid()) {
      const shell = keep(oc.TopoDS.Shell_1(keep(pipe.Shape())));
      const solidMaker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell));
      if (!solidMaker.IsDone()) {
        throw new Error(SWEEP_FAILED_MESSAGE);
      }
      return { shape: keep(solidMaker.Shape()), delete: release };
    }
    return { shape: keep(pipe.Shape()), delete: release };
  } catch (error) {
    release();
    // OCCT の C++ 例外は数値で飛んでくる(makeFillet.ts と同じ)。日本語の理由へ直す。
    throw error instanceof Error ? error : new Error(SWEEP_FAILED_MESSAGE);
  }
}

/** ねじの印(簡略表示、§0.a-0.15)。B-rep には触らず、描くための情報だけを返す。 */
function buildMarks(
  spec: ThreadStepSpec,
  origins: readonly Vec3Tuple[],
  direction: Vec3Tuple,
  placements: readonly RigidTransformSpec[],
): readonly ThreadMarkInfo[] {
  const mark = spec.mark;
  if (mark === null) {
    return [];
  }
  const marks: ThreadMarkInfo[] = [];
  for (const origin of origins) {
    for (const placement of placements) {
      marks.push({
        origin: applyTransformToPoint(placement, origin),
        direction: applyTransformToDirection(placement, direction),
        majorDiameter: mark.majorDiameter,
        length: mark.length,
      });
    }
  }
  return marks;
}

/**
 * 溝(実らせん)を中心の数 × 変換の数だけ作り、控えへ積んで形の一覧を返す。
 * 恒等の変換のときは複製を作らず、もとの溝をそのまま使う(makeHole.ts と同じ決め)。
 */
function buildThreadCuts(
  oc: OpenCascadeInstance,
  spec: ThreadStepSpec,
  thread: ThreadCutSpec,
  origins: readonly Vec3Tuple[],
  direction: Vec3Tuple,
  placements: readonly RigidTransformSpec[],
  keep: Allocations['keep'],
): readonly TopoDS_Shape[] {
  const shapes: TopoDS_Shape[] = [];
  for (const origin of origins) {
    const cut = keep(makeThreadCut(oc, origin, direction, thread, spec.drillDiameter));
    for (const placement of placements) {
      if (isIdentityTransform(placement)) {
        shapes.push(cut.shape);
        continue;
      }
      const moved = keep(transformShape(oc, cut.shape, placement));
      shapes.push(moved.shape);
    }
  }
  return shapes;
}

/**
 * ねじ穴をあける(FR-406)。対象は消費せず、新しい形と、画面へ返すねじの印を返す。
 *
 * 引数の `target` は解放しない(形状キャッシュの持ち物。`booleanOp` と同じ約束)。
 * `faces` は `target` から作った面の一覧で、別の形から作った一覧を渡すと
 * 「面が見つからない」で断る(`resolveHoleFrame` が判定する)。
 *
 * **実らせんを切るかどうかは `spec.representation` ではなく `spec.thread !== null` で決める**
 * (計画書 タスク9 手順5)。表示の選択を model が形の依頼へ畳んで渡すためである。
 */
export function makeThreadHole(
  oc: OpenCascadeInstance,
  spec: ThreadStepSpec,
  target: TopoDS_Shape,
  faces: readonly SolidFaceInfo[],
): { readonly handle: OcctShapeHandle; readonly marks: readonly ThreadMarkInfo[] } {
  const frame = resolveHoleFrame(oc, target, faces, spec);
  const placements = transformsOrIdentity(spec.transforms);
  const thread = spec.thread;
  if (thread !== null) {
    // 掃引を始める前に値を確かめる(掛かってから断ると数秒待たせることになる)。
    checkThreadSpec(thread, spec.drillDiameter);
  }

  const result = ((): OcctShapeHandle => {
    const { keep, release } = createAllocations();
    try {
      const drills = keep(
        makeHoleTools(oc, target, frame, spec.drillDiameter, spec.depth, spec.transforms),
      );

      let tool: TopoDS_Shape = drills.shape;
      if (thread !== null) {
        const cuts = buildThreadCuts(
          oc,
          spec,
          thread,
          frame.origins,
          frame.direction,
          placements,
          keep,
        );
        const grooves = keep(makeCompound(oc, cuts));
        // 重なり合う工具はコンパウンドではなく和で 1 つにする(この節の冒頭の注釈)。
        // ここで断るのは溝と下穴を組み合わせられなかったときなので、
        // 直し方は「簡略表示に切り替える」になる。
        const fused = keep(
          toJapaneseFailure(
            () => booleanOp(oc, 'union', drills.shape, grooves.shape),
            SWEEP_FAILED_MESSAGE,
          ),
        );
        tool = fused.shape;
      }

      return toJapaneseFailure(
        () => booleanOp(oc, 'subtract', target, tool),
        THREAD_FAILED_MESSAGE,
      );
    } finally {
      // 工具は差し引いた直後に解放してよい(makeHole.ts の実測と同じ)。
      release();
    }
  })();

  try {
    const removed = measureVolume(oc, target) - measureVolume(oc, result.shape);
    if (!(removed >= MIN_REMOVED_VOLUME_MM3)) {
      throw new Error(NOTHING_REMOVED_MESSAGE);
    }
    return { handle: result, marks: buildMarks(spec, frame.origins, frame.direction, placements) };
  } catch (error) {
    result.delete();
    throw error;
  }
}

/**
 * `booleanOp` の断りを、ねじ穴の言葉へ言い換える(makeHole.ts の `cutHoles` と同じ考え)。
 * 「立体が残らなかった」だけは直し方が違う(呼び径か深さを小さくする)ので言い回しで見分ける。
 * それ以外は、どの段でつまずいたかに合った案内(`fallback`)を出す。
 */
function toJapaneseFailure(run: () => OcctShapeHandle, fallback: string): OcctShapeHandle {
  try {
    return run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason.includes('立体が残りませんでした') ? NOTHING_LEFT_MESSAGE : fallback, {
      cause: error,
    });
  }
}
