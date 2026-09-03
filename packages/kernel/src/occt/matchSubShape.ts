/**
 * 部分形状(面・辺・頂点)の指紋の採点と選び直し(計画書 P3 §2.2、§0.a-0.4、タスク5)。
 *
 * B-rep の面・辺には名前が無く、手がかりは `TopExp` の並び順(通し番号)しか無い。
 * ところが上流の押し出しの距離を 10 → 20 に変えるだけで形が作り直され、番号がずれて
 * 別の面を指しうる(トポロジカルネーミング問題)。そこで文書は番号だけでなく
 * 種類・大きさ・軸・位置も一緒に保存し(`SubShapeQuery`)、再計算のたびに
 * ここで最も点の高いものを選び直す。届かなければ「見つからない」と断る(FR-504)。
 *
 * **このファイルは OCCT を一切使わない。** 引数はすべて素の数値と文字列で、
 * 理由は 2 つある。①採点は幾何の生値だけで決まるので、50MB の WASM を読み込まずに
 * Node で検査でき、所要が 1 秒未満で済む。②選び直しそのものはカーネル(Worker)の中で
 * 行う(§2.2.4)が、その判断を OCCT の呼び出しと混ぜると、重みを変えたときに
 * 何がどう変わったのかを追えなくなる。
 *
 * **重みとしきい値は統括の決定(§0.a-0.4)である。** 実測で変える必要が出たときは、
 * 変更する前に統括へ報告する(この値を動かすと、保存済みの文書の参照の当たり外れが
 * 一斉に変わるため)。
 */

import type {
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidVertexInfo,
  SubShapeQuery,
  Vec3Tuple,
} from '../types.js';

/**
 * 採点の重み(§0.a-0.4)。合計 1。
 *
 * 軸を最も重くしてあるのは、裏の面(法線が真逆)を確実に落とすため。
 * 大きさを 0.25 に抑えてあるのは、断面を 40×30 → 80×60 と相似に広げても
 * 同じ面を選び直せるようにするため(面積が 4 倍になっても 0.6 を超える。§2.2.3 の 4 例目)。
 */
export const MATCH_WEIGHT_AXIS = 0.35;
export const MATCH_WEIGHT_SIZE = 0.25;
export const MATCH_WEIGHT_INDEX = 0.2;
export const MATCH_WEIGHT_POSITION = 0.2;

/**
 * 頂点の重み(合計 1)。
 *
 * 頂点は軸も大きさも持たない(`SolidVertexInfo` は位置だけ)ので、面・辺の 4 つの
 * 重みは使えない。通し番号と位置を半分ずつにする(計画書 タスク5)。
 *
 * **限界:** しきい値は面・辺と同じ 0.6 を使うため、通し番号が変わった頂点は
 * 位置がぴったり同じでも 0.5 にしか届かず「見つからない」になる。
 * つまり頂点の参照は実質「番号が変わらないこと」が条件である。
 * これは計画書どおりの決めで、頂点を直に指す唯一の使い道(R 面取りで
 * 「頂点に集まる辺をすべて丸める」、§0.a-0.17)では、辺を選び直せば代わりが利く。
 */
export const MATCH_WEIGHT_VERTEX_INDEX = 0.5;
export const MATCH_WEIGHT_VERTEX_POSITION = 0.5;

/** これ未満の点しか取れなければ「見つからない」とする(§0.a-0.4)。 */
export const SUB_SHAPE_MATCH_THRESHOLD = 0.6;

/**
 * 選び直しの結果。しきい値に届かなかったときは null を返すので、
 * これが返ってきたときは必ずそのまま採用してよい。
 */
export interface SubShapeMatch {
  /** 選ばれた部分形状の通し番号。 */
  readonly index: number;
  /** 0〜1 の点。しきい値以上のときだけ返る。 */
  readonly score: number;
}

/**
 * 採点の内訳(検査と、将来の調整のために公開する)。
 *
 * `total` は重みをかけた合計で、面・辺は 4 つ、頂点は 2 つの重みで出す。
 * 頂点には軸も大きさも無いので `axis` / `size` は 0 が入り、`total` には効かない。
 */
export interface MatchScoreParts {
  readonly axis: number;
  readonly size: number;
  readonly index: number;
  readonly position: number;
  readonly total: number;
}

/** 2 点の距離(mm)。 */
function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 軸の点。両方に軸があれば `max(0, 内積)`、片方でも無ければ 0.5(§2.2.3)。
 *
 * 引数は長さ 1 の前提だが(`subShapes.ts` の `directionToTuple` が長さで割っている)、
 * 文書から読み込んだ指紋は古い版のこともあるので、ここでも正規化してから内積を取る。
 * 長さが取れない向き(0 ベクトル・非数)は「向きを言い表していない」ので軸が無いのと
 * 同じ扱いにする。
 *
 * 片方でも軸が無いときに 0(不一致)ではなく 0.5(どちらとも言えない)を返すのは、
 * 球や自由曲面のように軸を決められない形を、軸の欄だけで門前払いしないため。
 * 0.5 なら残りの 3 つ(大きさ・番号・位置)が満点でも 0.825 で、
 * 大きさか位置が大きく外れれば 0.6 を割る。
 */
export function scoreAxis(a: Vec3Tuple | null, b: Vec3Tuple | null): number {
  const first = toUnitVector(a);
  const second = toUnitVector(b);
  if (first === null || second === null) {
    return 0.5;
  }
  const dot = first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
  if (!Number.isFinite(dot)) {
    return 0.5;
  }
  // 丸め誤差で 1 をわずかに超えることがある(同じ向きどうしの内積が 1.0000000000000002)。
  // 上限で切っておかないと、重みの合計 1 を超えた点が出て「0〜1 の点」の約束が崩れる。
  // 下限の 0 は Math.max(0, -0) が +0 を返すので、-0 が混ざることもない。
  return Math.max(0, Math.min(1, dot));
}

/** 長さ 1 のタプルへ直す。向きが無い・長さが取れないときは null。 */
function toUnitVector(value: Vec3Tuple | null): Vec3Tuple | null {
  if (value === null) {
    return null;
  }
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [value[0] / length, value[1] / length, value[2] / length];
}

/**
 * 大きさの点(面積または長さ)。`min / max` で、両方 0 なら 1(§2.2.3)。
 *
 * 比にするのは、部品の大きさに依らず「何倍違うか」だけで見たいため。
 * 片方だけが 0 のときは `min / max` がそのまま 0 になる(別の大きさなので不一致)。
 * 負の値や非数は面積・長さとしてありえないので、0(不一致)として扱う。
 */
export function scoreSize(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
    return 0;
  }
  const larger = Math.max(a, b);
  if (larger === 0) {
    return 1;
  }
  return Math.min(a, b) / larger;
}

/**
 * 位置の点。`max(0, 1 − 距離 / scale)`(§2.2.3)。
 *
 * `scale` は候補全体の境界箱の対角長の半分(`boundingDiagonal(oc, shape) * 0.5`)で、
 * 部品の大きさに依らない点にするために割る。対角長の「半分」なのは、
 * 箱の端から端まで離れた候補でも 0 で底を打たせないため。
 *
 * `scale` が使えない(0 以下・非数)ときは 1 を返す。中身の無い形や 1 点だけの形では
 * 距離を正規化しようがないので、位置を判断材料から外して他の 3 つで決める。
 */
export function scorePosition(a: Vec3Tuple, b: Vec3Tuple, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) {
    return 1;
  }
  const gap = distance(a, b);
  if (!Number.isFinite(gap)) {
    return 0;
  }
  return Math.max(0, 1 - gap / scale);
}

/**
 * 通し番号の点。同じなら 1、違えば 0(§2.2.3)。
 *
 * 「1 番違いなら 0.5」のような近さの点にしないのは、通し番号が単なる並び順であって
 * 距離に意味が無いためである(1 番違いの面が形の上で隣にあるとは限らない)。
 * 番号は「上流が変わらなかったこと」を示す手がかりとしてだけ使い、
 * 変わったときは軸・大きさ・位置の 3 つで選び直す。
 */
function scoreIndex(a: number, b: number): number {
  return a === b ? 1 : 0;
}

/** 面・辺で共通の、重みをかけた合計。 */
function totalOf(axis: number, size: number, index: number, position: number): MatchScoreParts {
  return {
    axis,
    size,
    index,
    position,
    total:
      MATCH_WEIGHT_AXIS * axis +
      MATCH_WEIGHT_SIZE * size +
      MATCH_WEIGHT_INDEX * index +
      MATCH_WEIGHT_POSITION * position,
  };
}

/**
 * 面 1 枚の採点の内訳。
 *
 * 種類(`surfaceKind`)の一致は候補になるための必須の条件で、点では表さない。
 * `radius` も点には使わない(円柱の半径は面積と軸でほぼ決まり、二重に効かせると
 * 円柱だけが他の種類より厳しくなるため)。指紋に残してあるのは、
 * 将来「半径が同じ円柱を優先する」といった調整を後から足せるようにするためである。
 */
export function scoreFace(
  face: SolidFaceInfo,
  query: Extract<SubShapeQuery, { kind: 'face' }>,
  scale: number,
): MatchScoreParts {
  return totalOf(
    scoreAxis(face.axis, query.axis),
    scoreSize(face.area, query.area),
    scoreIndex(face.index, query.index),
    scorePosition(face.centroid, query.position, scale),
  );
}

/**
 * 辺 1 本の採点の内訳。面と同じ 4 つの重みを使う。
 * 位置は辺の中点で見る(`SolidEdgeInfo.midpoint`。長さ 0 の辺では両端の中点が入っている)。
 */
export function scoreEdge(
  edge: SolidEdgeInfo,
  query: Extract<SubShapeQuery, { kind: 'edge' }>,
  scale: number,
): MatchScoreParts {
  return totalOf(
    scoreAxis(edge.axis, query.axis),
    scoreSize(edge.length, query.length),
    scoreIndex(edge.index, query.index),
    scorePosition(edge.midpoint, query.position, scale),
  );
}

/**
 * 頂点 1 つの採点の内訳。軸も大きさも無いので `0.5 × 通し番号 + 0.5 × 位置` で出す。
 * `axis` / `size` は 0 を入れるが、合計には効かない(重みが別だから)。
 */
export function scoreVertex(
  vertex: SolidVertexInfo,
  query: Extract<SubShapeQuery, { kind: 'vertex' }>,
  scale: number,
): MatchScoreParts {
  const index = scoreIndex(vertex.index, query.index);
  const position = scorePosition(vertex.position, query.position, scale);
  return {
    axis: 0,
    size: 0,
    index,
    position,
    total: MATCH_WEIGHT_VERTEX_INDEX * index + MATCH_WEIGHT_VERTEX_POSITION * position,
  };
}

/**
 * 候補の中から最も点の高いものを選ぶ。しきい値に届かなければ null。
 *
 * **同点のときは通し番号が小さいほうを採る(決定性)。** 同じ入力から必ず同じ答えが
 * 出ないと、再計算するたびに参照が別の面へ飛び移り、原因の追えない形の揺れになる。
 * 「先に見つかったほう」ではなく番号で決めるのは、候補の並びが変わっても答えを
 * 変えないためである(一覧は通し番号の順で来る約束だが、それに依存しない)。
 *
 * 引数の配列は読むだけで、並べ替えも書き換えもしない。
 */
function selectBest<T>(
  candidates: readonly T[],
  isCandidate: (item: T) => boolean,
  indexOf: (item: T) => number,
  score: (item: T) => number,
): SubShapeMatch | null {
  let best: SubShapeMatch | null = null;

  for (const candidate of candidates) {
    if (!isCandidate(candidate)) {
      continue;
    }
    const index = indexOf(candidate);
    const total = score(candidate);
    if (!Number.isFinite(total)) {
      continue;
    }
    if (best === null || total > best.score || (total === best.score && index < best.index)) {
      best = { index, score: total };
    }
  }

  if (best === null || best.score < SUB_SHAPE_MATCH_THRESHOLD) {
    return null;
  }
  return best;
}

/**
 * 指紋に最も近い面を選び直す(§2.2)。しきい値に届かなければ null。
 *
 * 候補は `surfaceKind` が一致するものだけ(平面の指紋が円柱面に当たることは無い)。
 * 同点なら通し番号が小さいほう(決定性)。
 * `scale` は位置の正規化に使う長さ(境界箱の対角長 × 0.5)。0 以下なら位置の点は 1 とする。
 */
export function matchFace(
  faces: readonly SolidFaceInfo[],
  query: Extract<SubShapeQuery, { kind: 'face' }>,
  scale: number,
): SubShapeMatch | null {
  return selectBest(
    faces,
    (face) => face.surfaceKind === query.surfaceKind,
    (face) => face.index,
    (face) => scoreFace(face, query, scale).total,
  );
}

/**
 * 指紋に最も近い辺を選び直す。候補は `curveKind` が一致するものだけ。
 * 面と同じ重み・同じしきい値・同じ同点の決め方を使う。
 */
export function matchEdge(
  edges: readonly SolidEdgeInfo[],
  query: Extract<SubShapeQuery, { kind: 'edge' }>,
  scale: number,
): SubShapeMatch | null {
  return selectBest(
    edges,
    (edge) => edge.curveKind === query.curveKind,
    (edge) => edge.index,
    (edge) => scoreEdge(edge, query, scale).total,
  );
}

/**
 * 指紋に最も近い頂点を選び直す。頂点には種類が無いので、候補は全部である。
 * 重みだけが面・辺と違う(`MATCH_WEIGHT_VERTEX_INDEX` の説明を参照)。
 */
export function matchVertex(
  vertices: readonly SolidVertexInfo[],
  query: Extract<SubShapeQuery, { kind: 'vertex' }>,
  scale: number,
): SubShapeMatch | null {
  return selectBest(
    vertices,
    () => true,
    (vertex) => vertex.index,
    (vertex) => scoreVertex(vertex, query, scale).total,
  );
}
