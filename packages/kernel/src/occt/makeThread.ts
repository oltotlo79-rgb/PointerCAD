/**
 * ねじ穴(FR-406、計画書 P3 §2.4、タスク9)と、おねじ(FR-423、計画書 P5 §0.a-0.40、
 * タスク40)。
 *
 * **めねじとおねじが共用するのは、らせんと三角形の断面から溝を作る `makeThreadGroove`**
 * である(同じ規則を 2 か所に書かない)。違いは「材料の表面より外へ削るか内へ削るか」
 * だけで、それは `ThreadGrooveSpec` の `wallRadius` と `apexRadius` の大小で表す。
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
  SubShapeQuery,
  ThreadCutSpec,
  ThreadMarkInfo,
  ThreadStepSpec,
  Vec3Tuple,
} from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { BooleanResult } from './booleanOp.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { helixAxisFrame, makeHelixWire } from './makeHelix.js';
import type { HoleFrame } from './makeHole.js';
import { holeEntryDepth, makeHoleTools, resolveHoleFrame } from './makeHole.js';
import { matchFace } from './matchSubShape.js';
import { measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, faceAt } from './subShapes.js';
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

/** おねじの面が選び直せなかったとき(FR-504、§2.2.5)。 */
const MISSING_SHAFT_FACE_MESSAGE =
  'おねじを作るもとの面が見つかりません。形が大きく変わったため、選び直してください。';

/** おねじを平面などに掛けようとしたとき(FR-423 は円柱状の軸部だけを対象にする)。 */
const CYLINDER_ONLY_MESSAGE = 'おねじを作れるのは円柱の面だけです。';

/** おねじの呼び径が 0 以下・非数のとき(印に載せる値なので数であることを確かめる)。 */
const SHAFT_MAJOR_DIAMETER_MESSAGE = 'おねじの呼び径は 0 より大きい数にしてください。';

/** ピッチに対して軸が細すぎ、谷の径が 0 以下になるとき。 */
const SHAFT_TOO_THIN_MESSAGE = 'ねじのピッチが軸の太さに対して大きすぎます。呼び径を見直してください。';

/** おねじのブーリアンそのものが成立しなかったとき。 */
const SHAFT_FAILED_MESSAGE = 'おねじを作れませんでした。ねじ部の長さや向きを見直してください。';

/** おねじで軸が丸ごと削れてしまったとき。 */
const SHAFT_NOTHING_LEFT_MESSAGE = 'おねじを切ったら立体が残りませんでした。呼び径を見直してください。';

/** おねじの溝が材料に当たらなかったとき(makeHole.ts と同じ考え)。 */
const SHAFT_NOTHING_REMOVED_MESSAGE =
  'おねじの溝が軸に当たりませんでした。ねじ部の長さや向きを見直してください。';

/**
 * おねじの山の高さ h3 が、ピッチの何倍か。**`h3 = (17/24)·H`、`H = (√3/2)·P`**
 * (基本山形、ISO 68-1。§0.a-0.13 がめねじで使っている表と同じ出どころ)。
 * 谷の径は `d3 = d − 2·h3 = d − 1.2268693…·P` になる。
 *
 * **ピッチから出すのは、`ThreadShaftInput` が谷の径を持たないためである**
 * (計画書 タスク40 の実装内容)。呼び径と系列から谷の径を引くのは model の表の役目だが、
 * おねじでは「軸の実寸(円柱面の指紋から測った半径)から山の高さぶんだけ削る」ほうが
 * 形として正しい(呼び径と軸の実寸が少しずれていても、山の頂が必ず軸の外周に乗る)。
 */
const EXTERNAL_CREST_RATIO = (17 / 24) * (Math.sqrt(3) / 2);

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

/**
 * 溝(ねじ山を削り取る形)1 本の指定。**めねじとおねじが同じ形で使う**(§0.a-0.40)。
 *
 * めねじ(ねじ穴)は「下穴の壁より外側(材料の奥)へ」、おねじ(軸)は
 * 「軸の外周より内側(材料の奥)へ」削るという違いだけなので、
 * **材料の表面の半径 `wallRadius` と山の頂点の半径 `apexRadius` の 2 つ**で言い表す。
 * `apexRadius > wallRadius` ならめねじ、`apexRadius < wallRadius` ならおねじになる。
 */
interface ThreadGrooveSpec {
  /** ねじの切り始め(めねじは下穴の口、おねじは軸の端)。 */
  readonly origin: Vec3Tuple;
  /** 切り進む向き(単位ベクトル)。 */
  readonly direction: Vec3Tuple;
  readonly pitch: number;
  /** ねじ部の長さ(mm)。 */
  readonly length: number;
  /** 材料の表面の半径(めねじ = 下穴の壁、おねじ = 軸の外周)。 */
  readonly wallRadius: number;
  /** 山の頂点の半径(材料の奥にある側)。 */
  readonly apexRadius: number;
}

/** 掃引路(らせん)の半径。材料の表面と山の頂点の中間(§2.4.2 の手順 12)。 */
function grooveSweepRadius(wallRadius: number, apexRadius: number): number {
  return (wallRadius + apexRadius) / 2;
}

/**
 * 掃引路(らせん)の半径を径で受ける版(めねじ。§2.4.2 の手順 12)。
 * 規則そのものは `grooveSweepRadius` に 1 つだけ置く。
 */
export function threadSweepRadius(majorDiameter: number, drillDiameter: number): number {
  return grooveSweepRadius(drillDiameter / 2, majorDiameter / 2);
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
 * **軸を含む平面の上**に置く。山の頂点は `apexRadius` の位置(材料の奥)、底辺は
 * 材料の表面よりすこし外側(空所の側)で、軸方向にピッチの 3/4 の幅を持つ。
 * 掃引の始点(らせんの u = 0 の点)を基準にするので、`makeHelixWire` が作る
 * 掃引路とぴったり噛み合う。
 *
 * **符号つきの山の高さ(`crest`)で、めねじとおねじを 1 つの式に収めてある。**
 * めねじでは `crest > 0` で底辺が壁より内側(下穴の空所の側)へ、おねじでは
 * `crest < 0` で底辺が外周より外側(軸の外)へ寄る。どちらも「材料の外へ
 * 食い込ませる」という同じ意味で、出来上がる形は変わらない(`PROFILE_INSET_RATIO`)。
 */
function makeThreadProfile(
  oc: OpenCascadeInstance,
  spec: ThreadGrooveSpec,
  keep: Allocations['keep'],
): TopoDS_Wire {
  const frame = helixAxisFrame(spec.direction);
  if (frame === null) {
    throw new Error(SWEEP_FAILED_MESSAGE);
  }
  const { xAxis, zAxis } = frame;
  const { origin, wallRadius, apexRadius } = spec;
  const sweepRadius = grooveSweepRadius(wallRadius, apexRadius);
  const crest = apexRadius - wallRadius;
  // 掃引路の上の点(らせんの始点)からの、半径方向・軸方向のずれで断面を書く。
  const towardApex = apexRadius - sweepRadius;
  const towardVoid = wallRadius - crest * PROFILE_INSET_RATIO - sweepRadius;
  const half = (spec.pitch * PROFILE_BASE_RATIO) / 2;

  const at = (radial: number, along: number): Vec3Tuple => [
    origin[0] + (sweepRadius + radial) * xAxis[0] + along * zAxis[0],
    origin[1] + (sweepRadius + radial) * xAxis[1] + along * zAxis[1],
    origin[2] + (sweepRadius + radial) * xAxis[2] + along * zAxis[2],
  ];
  const corners: readonly Vec3Tuple[] = [
    at(towardApex, 0),
    at(towardVoid, -half),
    at(towardVoid, half),
  ];

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
 * ねじ 1 本ぶんの実らせん(掃引した溝)。**めねじ・おねじが共用する本体**で、
 * 値の門番はそれぞれの入口(`makeThreadCut` / `makeThreadShaft`)が済ませてある。
 *
 * **巻き方向は常に右**である(JIS のメートルねじは右ねじ。左ねじは P5 以降)。
 * 軸の向きを反転して同じ「右」で作ると、同じ 1 本のらせんを逆の端からたどった形になる
 * ので、おねじの `fromEnd: 'last'` でも右ねじのままになる。
 *
 * 返した handle の delete() で、掃引路・断面・掃引の maker と結果の形をまとめて解放する。
 */
function makeThreadGroove(oc: OpenCascadeInstance, spec: ThreadGrooveSpec): OcctShapeHandle {
  const { origin, direction } = spec;
  const { keep, release } = createAllocations();
  try {
    const spine = makeHelixWire(
      oc,
      {
        origin,
        direction,
        radius: grooveSweepRadius(spec.wallRadius, spec.apexRadius),
        pitch: spec.pitch,
        turns: spec.length / spec.pitch,
        handedness: 'right',
      },
      keep,
    );
    const profile = makeThreadProfile(oc, spec, keep);

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

/**
 * めねじ 1 本ぶんの実らせん(掃引した溝)。簡略表示のときは呼ばない。
 *
 * `origin` は下穴の口(ねじの切り始め)、`direction` は掘り進む向き。
 * 山の頂点は外径 d(材料の奥)、底辺は下穴の壁のすこし内側になる。
 */
export function makeThreadCut(
  oc: OpenCascadeInstance,
  origin: Vec3Tuple,
  direction: Vec3Tuple,
  spec: ThreadCutSpec,
  drillDiameter: number,
): OcctShapeHandle {
  checkThreadSpec(spec, drillDiameter);
  return makeThreadGroove(oc, {
    origin,
    direction,
    pitch: spec.pitch,
    length: spec.length,
    wallRadius: drillDiameter / 2,
    apexRadius: spec.majorDiameter / 2,
  });
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
 * ねじの切り始め。入口(ざぐり・皿もみ、FR-422)があれば、**その底からねじ山が始まる**
 * ように、面へ投影した中心を掘り進む向きへ入口の深さだけ下げる(タスク42c)。
 *
 * **削れる量は「入口が無いときと同じ量 + 入口の削れ量」になる。** 切り始めより上へ
 * はみ出す溝の断面(ピッチの 3/8 ぶん)は、入口が無ければ材料の外(面より上)に、
 * 入口があれば入口が削り取った空所の中に入るので、どちらでも材料を削らないためである
 * (入口の径・頭径は必ず下穴の径より大きい = 溝の山の頂より外にある)。
 * `makeThread.test.ts` が実らせんの体積でこの等式を固定している。
 *
 * 入口の深さの式(皿もみ)は `makeHole.ts` の `holeEntryDepth` 1 か所だけに置く。
 */
function threadOrigins(frame: HoleFrame, spec: ThreadStepSpec): readonly Vec3Tuple[] {
  const depth = holeEntryDepth(spec.entry, spec.drillDiameter);
  if (depth === 0) {
    return frame.origins;
  }
  const { direction } = frame;
  return frame.origins.map((origin) => [
    origin[0] + direction[0] * depth,
    origin[1] + direction[1] * depth,
    origin[2] + direction[2] * depth,
  ]);
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
 *
 * **入口の形(`spec.entry`、FR-422)は穴とまったく同じ道を通る**(タスク42c)。
 * ざぐりの円柱・皿もみの円錐を下穴と和でまとめるのは `makeHoleTools` の仕事なので、
 * ここは受け取った欄をそのまま渡すだけで、同じ規則を 2 か所に書かない。
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
      // 入口の形(ざぐり・皿もみ)の値の検査も makeHoleTools が済ませる(穴と同じ文言で断る)。
      const drills = keep(
        makeHoleTools(oc, frame, spec.drillDiameter, spec.depth, spec.transforms, spec.entry),
      );

      let tool: TopoDS_Shape = drills.shape;
      if (thread !== null) {
        const cuts = buildThreadCuts(
          oc,
          spec,
          thread,
          // 入口があれば、その底からねじ山を始める(`threadOrigins` の注釈)。
          threadOrigins(frame, spec),
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
    // 印は入口があっても変わらない(簡略表示の印は面の口から測る。§0.a-0.15)ので、
    // 下げる前の `frame.origins` を渡す。
    return { handle: result, marks: buildMarks(spec, frame.origins, frame.direction, placements) };
  } catch (error) {
    result.delete();
    throw error;
  }
}

/**
 * `booleanOp` の断りを、ねじの言葉へ言い換える(makeHole.ts の `cutHoles` と同じ考え)。
 * 「立体が残らなかった」だけは直し方が違うので言い回しで見分け、`nothingLeft` を出す。
 * それ以外は、どの段でつまずいたかに合った案内(`fallback`)を出す。
 *
 * 戻り値の型をそのまま通すのは、`booleanOp` が測り済みの体積を持って返す
 * (`BooleanResult`)ぶんを、呼び出し側が測り直さずに使えるようにするためである。
 */
function toJapaneseFailure<T extends OcctShapeHandle>(
  run: () => T,
  fallback: string,
  nothingLeft: string = NOTHING_LEFT_MESSAGE,
): T {
  try {
    return run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason.includes('立体が残りませんでした') ? nothingLeft : fallback, {
      cause: error,
    });
  }
}

/**
 * おねじ 1 段の依頼(FR-423、計画書 タスク40 の実装内容)。
 *
 * 深さ・貫通の概念は無く、**円柱面の指紋 1 つ**と「軸のどちらの端から」「長さ」で決まる
 * (§0.a-0.40)。呼び径とピッチは model が規格データ(`metricThread.ts`)から引いて渡す。
 */
export interface ThreadShaftInput {
  /** ねじを切る円柱面の指紋。平面など円柱でない面は断る。 */
  readonly face: SubShapeQuery;
  /** 呼び径 d(mm)。**印に載せる値**で、削る深さは軸の実寸とピッチから決める。 */
  readonly majorDiameter: number;
  readonly pitch: number;
  /** ねじ部の長さ(mm)。 */
  readonly length: number;
  /** 軸のどちらの端から切り始めるか。`first` は円柱面の軸のパラメータが小さいほうの端。 */
  readonly fromEnd: 'first' | 'last';
  /** 実らせんを切るなら true。false(既定の簡略表示)なら B-rep に触れない。 */
  readonly modeled: boolean;
}

/** 円柱面から読んだ、おねじを切るための座標系。 */
interface ShaftAxis {
  /** ねじの切り始め(選んだ端の、軸の上の点)。 */
  readonly start: Vec3Tuple;
  /** 切り進む向き(単位ベクトル)。もう一方の端へ向かう。 */
  readonly direction: Vec3Tuple;
  /** 軸の半径(mm)。**利用者に入れさせず、面から測る**(§0.a-0.40、NFR-UX-4)。 */
  readonly radius: number;
}

/** -0 を +0 へ揃える(subShapes.ts と同じ理由)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** おねじの値を確かめる。断るときは日本語の Error(FR-504)。OCCT を呼ぶ前に済ませる。 */
function checkShaftInput(input: ThreadShaftInput): void {
  if (!Number.isFinite(input.pitch) || input.pitch <= 0) {
    throw new Error(PITCH_MESSAGE);
  }
  if (!Number.isFinite(input.length) || input.length <= 0) {
    throw new Error(THREAD_LENGTH_MESSAGE);
  }
  if (!Number.isFinite(input.majorDiameter) || input.majorDiameter <= 0) {
    throw new Error(SHAFT_MAJOR_DIAMETER_MESSAGE);
  }
}

/**
 * 円柱面を指紋で選び直し、軸・半径・端を読む(計画書 タスク40 の手順 4)。
 *
 * 半径と軸は `BRepAdaptor_Surface_2(face).Cylinder()` から取る。**面の向き
 * (Orientation)による符号の反転はしない。** 指紋の `axis`(`subShapes.ts` が
 * 反転を掛けた値)は面を選び直すための目印で、ここで要るのは幾何そのものの軸だからである。
 * 端は円柱面の v の範囲(**軸に沿った距離そのもの**)で決める。2026-09-05 に Node で
 * 実測したところ、φ10×20 の軸では v が 0〜20、原点を (3,4,7) へ動かした軸でも
 * 軸の位置が (3,4,7)・v が 0〜20 になり、`位置 + v·向き` で端の点が求まった。
 */
function readShaftAxis(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: ThreadShaftInput,
): ShaftAxis {
  const query = input.face;
  if (query.kind !== 'face') {
    // 面以外(辺・頂点)の指紋が来るのは model 側の取り違えだが、
    // 利用者に見せるのは「面が見つからない」で足りる(直し方は同じ = 面を選び直す)。
    throw new Error(MISSING_SHAFT_FACE_MESSAGE);
  }
  // 位置の点は「候補全体の境界箱の対角長の半分」で正規化する(§2.2.3)。
  const match = matchFace(tables.faces, query, boundingDiagonal(oc, target) * 0.5);
  if (match === null) {
    throw new Error(MISSING_SHAFT_FACE_MESSAGE);
  }
  const info = tables.faces.find((candidate) => candidate.index === match.index);
  if (info === undefined) {
    throw new Error(MISSING_SHAFT_FACE_MESSAGE);
  }
  if (info.surfaceKind !== 'cylinder') {
    throw new Error(CYLINDER_ONLY_MESSAGE);
  }
  const face = faceAt(oc, target, match.index);
  if (face === null) {
    // 一覧と形が食い違っている(別の形から作った一覧を渡している)合図。
    throw new Error(MISSING_SHAFT_FACE_MESSAGE);
  }

  const { keep, release } = createAllocations();
  try {
    keep(face);
    // 第 2 引数 true は「面の境界(トリム)も読み込む」指定。端の位置に v の範囲が要るので、
    // 種類と軸だけを読む subShapes.ts(false)と違ってここでは省けない。
    const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
    if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      // 指紋の種類と下地の曲面が食い違うのは、別の形から作った一覧を渡したときだけ。
      throw new Error(CYLINDER_ONLY_MESSAGE);
    }
    const cylinder = keep(adaptor.Cylinder());
    const axis = keep(cylinder.Axis());
    const location = keep(axis.Location());
    const axisDirection = keep(axis.Direction());
    const radius = cylinder.Radius();
    const first = adaptor.FirstVParameter();
    const last = adaptor.LastVParameter();
    if (
      !Number.isFinite(radius) ||
      radius <= 0 ||
      !Number.isFinite(first) ||
      !Number.isFinite(last)
    ) {
      // 無限に伸びた円柱面(トリムされていない面)などはここで止める。
      throw new Error(SHAFT_FAILED_MESSAGE);
    }

    // gp_Dir は長さ 1 に揃っている。`last` の端から切るときは向きを反転する。
    const sign = input.fromEnd === 'first' ? 1 : -1;
    const along: Vec3Tuple = [
      normalizeZero(axisDirection.X()),
      normalizeZero(axisDirection.Y()),
      normalizeZero(axisDirection.Z()),
    ];
    const at = input.fromEnd === 'first' ? first : last;
    return {
      start: [
        normalizeZero(location.X() + along[0] * at),
        normalizeZero(location.Y() + along[1] * at),
        normalizeZero(location.Z() + along[2] * at),
      ],
      direction: [
        normalizeZero(along[0] * sign),
        normalizeZero(along[1] * sign),
        normalizeZero(along[2] * sign),
      ],
      radius,
    };
  } finally {
    release();
  }
}

/**
 * 形を作り変えずに handle だけを新しくする(簡略表示のとき、§0.a-0.15)。
 *
 * 恒等の配置で「同じ実体を指す別の `TopoDS_Shape`」を作る。**B-rep は 1 つも作り直さない。**
 * 2026-09-05 に Node で実測したところ、面と辺と頂点が 34 個の板で 0ms、`IsSame()` が真、
 * 部分形状の数も同じで、複製を delete() したあとももとの形の体積が測れた
 * (実体は参照が数えられており、複製の解放では消えない)。
 * 第 2 引数 false は「動かせない形でも例外を投げない」指定。
 */
function copyShapeHandle(oc: OpenCascadeInstance, shape: TopoDS_Shape): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const location = keep(new oc.TopLoc_Location_1());
    return { shape: keep(shape.Moved(location, false)), delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * おねじを切る(FR-423)。**対象は消費せず、新しい形と、画面へ返すねじの印を返す。**
 *
 * 引数の `target` は解放しない(形状キャッシュの持ち物。`booleanOp` と同じ約束)。
 * `tables` は `target` から作った一覧で、別の形から作った一覧を渡すと
 * 「面が見つからない」で断る。
 *
 * **簡略表示(`modeled: false`)では B-rep に触れない**(§0.a-0.15)。印だけを返し、
 * 形はもとのまま渡すので、再計算の費用はほぼ 0 になる。
 *
 * **実らせん(`modeled: true`)は、軸の外周から山ぶんを削り取る**(§0.a-0.40)。
 * めねじとの違いは山の頂点が軸の内側にあることだけで、掃引そのものは
 * `makeThreadGroove` を共用する。山の高さはピッチから出す(`EXTERNAL_CREST_RATIO`)。
 */
export function makeThreadShaft(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: ThreadShaftInput,
): { readonly handle: OcctShapeHandle; readonly mark: ThreadMarkInfo } {
  checkShaftInput(input);
  const axis = readShaftAxis(oc, target, tables, input);
  const mark: ThreadMarkInfo = {
    origin: axis.start,
    direction: axis.direction,
    majorDiameter: input.majorDiameter,
    length: input.length,
  };
  if (!input.modeled) {
    return { handle: copyShapeHandle(oc, target), mark };
  }

  const apexRadius = axis.radius - input.pitch * EXTERNAL_CREST_RATIO;
  if (!(apexRadius > 0)) {
    throw new Error(SHAFT_TOO_THIN_MESSAGE);
  }

  const result = ((): BooleanResult => {
    const { keep, release } = createAllocations();
    try {
      const groove = keep(
        makeThreadGroove(oc, {
          origin: axis.start,
          direction: axis.direction,
          pitch: input.pitch,
          length: input.length,
          wallRadius: axis.radius,
          apexRadius,
        }),
      );
      return toJapaneseFailure(
        () => booleanOp(oc, 'subtract', target, groove.shape),
        SHAFT_FAILED_MESSAGE,
        SHAFT_NOTHING_LEFT_MESSAGE,
      );
    } finally {
      // 工具は差し引いた直後に解放してよい(makeHole.ts の実測と同じ)。
      release();
    }
  })();

  try {
    // 結果の体積は booleanOp がすでに測ってあるので測り直さない(`BooleanResult`)。
    const removed = measureVolume(oc, target) - result.volume;
    if (!(removed >= MIN_REMOVED_VOLUME_MM3)) {
      throw new Error(SHAFT_NOTHING_REMOVED_MESSAGE);
    }
    return { handle: result, mark };
  } catch (error) {
    result.delete();
    throw error;
  }
}
