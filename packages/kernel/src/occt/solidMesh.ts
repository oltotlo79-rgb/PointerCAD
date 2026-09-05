import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type {
  SolidBodyKind,
  SolidBodyMesh,
  TessellationOptions,
  ThreadMarkInfo,
} from '../types.js';
import { extractEdges } from './extractEdges.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * BRepGProp.VolumeProperties_1 の OnlyClosed に渡す値。
 *
 * 2026-09-03 に Node で実測した結果(計画書 §1.2 の未確認点 2):
 *   10 × 20 × 30 の箱     OnlyClosed=false → 6000 / OnlyClosed=true → 6000
 *   同じ箱を縫合した立体   OnlyClosed=false → 6000 / OnlyClosed=true → 6000
 *   箱の 5 面だけの開いた殻 OnlyClosed=false → 4800 / OnlyClosed=true → 0
 *
 * 閉じた立体ではどちらでも同じ値になるので false を採る。
 * 閉じ切らなかった形で 0 ではなく途中までの値が出るほうが、
 * 「縫合が閉じなかった」ことに気づきやすく原因を追いやすいため(FR-504)。
 * 閉じているかどうかは hasSolid と isValidShape で別に判定する。
 */
const VOLUME_ONLY_CLOSED = false;

/**
 * 立体の体積(mm³)。
 * 閉じていない形では 0 に近い値や負の値が出るので、呼び出し側が妥当性も見る。
 */
export function measureVolume(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const properties = new oc.GProp_GProps_1();
  try {
    // 第 4・第 5 引数は SkipShared と UseTriangulation。
    // 共有面を飛ばさず、三角形近似ではなく厳密な面で積分する(既定の精度)。
    oc.BRepGProp.VolumeProperties_1(shape, properties, VOLUME_ONLY_CLOSED, false, false);
    return properties.Mass();
  } finally {
    properties.delete();
  }
}

/**
 * 形の表面積(mm²)。測定(FR-1102)と曲面の検証(FR-428)に使う。
 *
 * 体積(`measureVolume`)と同じ約束で測る。第 3・第 4 引数は SkipShared と
 * UseTriangulation で、共有面を飛ばさず、三角形近似ではなく厳密な面で積分する
 * (面 1 枚ごとの面積を測る `subShapes.ts` の `buildFaceInfo` とも同じ指定なので、
 * 全体の表面積と面ごとの面積の合計が食い違わない)。
 *
 * 閉じていない形(面だけの殻)でも面の合計がそのまま返るので、
 * `bodyKind` が `'shell'` のボディでも 0 にはならない(§0.a-0.45 の
 * 「shell の段だけ体積 0 を通して面積 > 0 を確かめる」の材料)。
 */
export function measureArea(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const properties = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(shape, properties, false, false);
    return properties.Mass();
  } finally {
    properties.delete();
  }
}

/**
 * B-rep として妥当か(自己交差・不正な向きが無いか)。
 * 第 2 引数 true は曲面そのものの検査も行う指定、第 3 引数 false は並列実行しない指定。
 * IsValid_2() は引数を取らない版で、構築時に渡した形を検査する
 * (IsValid_1(S) は部分形状を指定する版なので使わない)。
 */
export function isValidShape(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const analyzer = new oc.BRepCheck_Analyzer(shape, true, false);
  try {
    return analyzer.IsValid_2();
  } finally {
    analyzer.delete();
  }
}

/**
 * 形が閉じたソリッドを 1 つ以上含むか。
 *
 * tessellate.ts と同じく TopExp_Explorer を使わず TopExp.MapShapes_2 で部分形状を集め、
 * ShapeType() の値どうしの比較でソリッドを選ぶ。opencascade.js の型定義では
 * 列挙の各値(TopAbs_SOLID 等)が空の型 `{}` になっており、列挙を引数に取る
 * TopExp_Explorer.Init は強制変換なしでは型検査を通せないため。
 * MapShapes_2 は形そのものも含めて数えるので、単体のソリッドでも true になる。
 */
export function hasSolid(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  try {
    // 第 3・第 4 引数は「向きと位置を親からたどって積み上げる」指定で、
    // TopExp_Explorer と同じ結果になる既定値。
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const solidType = oc.TopAbs_ShapeEnum.TopAbs_SOLID;
    const subShapeCount = subShapes.Size();
    for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
      if (subShapes.FindKey(subShapeIndex).ShapeType() === solidType) {
        return true;
      }
    }
    return false;
  } finally {
    subShapes.delete();
  }
}

/**
 * 表示用データを 1 回でまとめて作る(FR-105、FR-310、計画書 §2.8、タスク10)。
 * 面の三角形は tessellate、稜線は extractEdges が作り、両方の範囲表を
 * `collectSubShapes`(subShapes.ts)へ渡して面・辺・頂点の一覧(指紋の材料、§2.2)を添える。
 * 3 つの関数はすべて同じ `TopExp.MapShapes_2(shape, ..., true, true)` の並びで
 * 部分形状を数えるので、通し番号は必ず 1 対 1 に対応する(tessellate.ts / extractEdges.ts /
 * subShapes.ts の注釈のとおり)。返す値は TypedArray と数値・文字列・配列だけなので、
 * そのまま Comlink 越しに渡せる。形の解放は呼び出し側の責任(この関数は shape を消費しない)。
 *
 * `threadMarks` はねじ穴(タスク9)だけが渡す、B-rep に現れない描画用の印(§0.a-0.15)。
 * 渡されなければ空配列にする(押し出し・回転・穴・面取り・ばね等はねじの印を持たない)。
 *
 * **形の種類(`bodyKind`)は必ず返す**(FR-428。`SolidBodyMesh` の必須の欄。§0.a-0.77)。
 * 判定は `hasSolid` そのままで安く、**体積では決めない**——ふたの無い開いた殻は体積が 0 とは
 * 限らない(タスク41 の実測: 体積 8000 の開いた殻)ので、体積からは見分けられないためである。
 * `'shell'` が来るのは曲面の段(`makeSurface.ts`)から。
 *
 * **表面積(`area`)は `measureAreas` が true のときだけ返す**(P5 タスク14、統括の決定
 * 2026-09-05)。形が手元にあるこの場でしか安く測れないが、それでもただではない
 * (2026-09-05 実測: 面 26 枚の板で 11.4ms)ので、測定・質量特性(FR-1101・FR-1102)が
 * 値を要る依頼のときだけ測る。理由の全文は `types.ts` の `SolidRecomputeRequest.measureAreas`
 * の注釈にある。**測るときは、面ごとの面積を足し合わせるのではなく形そのものから直に測る**
 * (足し合わせると、面の一覧の作り方(共有面の数え方)に結果が引きずられるため)。
 *
 * **表面積も `knownArea` が渡されたらそれを使い、測り直さない**(P5 タスク42b、
 * §0.a-0.83)。曲面の段(`makeSurface.ts`)は「面ができたか」を確かめるために結果の面積を
 * 必ず 1 回測っており(`SurfaceResult.area`)、同じ形をもう一度測っても同じ値にしかならない。
 * `knownVolume` とまったく同じ流儀で、**測るかどうかの判断(`measureAreas`)は変えない**
 * ——求められていなければ、覚えている値があっても欄ごと落とす(振る舞いを変えないため)。
 *
 * **体積(`volume`)は `knownVolume` が渡されたらそれを使い、測り直さない**
 * (P5 仕上げ (b)、2026-09-05)。ブーリアンを通った段(和・差・積・穴)は
 * `booleanOp` が「立体が残ったか」の判定のために同じ形の体積をすでに測っている
 * (`booleanOp.ts` の `BooleanResult`)。同じ形をもう一度測っても必ず同じ値になるので、
 * 測り直すぶん(面 26 枚・辺 72 本の板で 7.5〜11ms)がそのまま無駄になる。
 * 渡されなければ従来どおりここで測る。
 */
export function buildSolidBodyMesh(
  oc: OpenCascadeInstance,
  id: string,
  shape: TopoDS_Shape,
  options: TessellationOptions = {},
  threadMarks: readonly ThreadMarkInfo[] = [],
  measureAreas = true,
  knownVolume?: number,
  knownArea?: number,
): SolidBodyMesh {
  const surface = tessellate(oc, shape, options);
  const edges = extractEdges(oc, shape, options);
  const subShapes = collectSubShapes(oc, shape, surface.faceRanges, edges.edgeRanges);
  const bodyKind: SolidBodyKind = hasSolid(oc, shape) ? 'solid' : 'shell';

  return {
    id,
    positions: surface.positions,
    normals: surface.normals,
    indices: surface.indices,
    edgePositions: edges.positions,
    triangleCount: surface.triangleCount,
    faceCount: surface.faceCount,
    edgeCount: edges.edgeCount,
    volume: knownVolume ?? measureVolume(oc, shape),
    // 求められていないときは欄ごと落とす(undefined を入れるのと同じだが、
    // 「測っていない」ことが JSON の見た目でも分かるようにする)。
    // 作り手がすでに測ってあれば(`knownArea`)その値を使い、同じ形を測り直さない。
    ...(measureAreas ? { area: knownArea ?? measureArea(oc, shape) } : {}),
    bodyKind,
    faces: subShapes.faces,
    edges: subShapes.edges,
    vertices: subShapes.vertices,
    threadMarks,
  };
}
