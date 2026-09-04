/**
 * 部分形状(面・辺・頂点)の選択の規約(計画書 docs/plans/P3-加工フィーチャー.md タスク20、
 * §0.a-0.6、§0.a-0.8、§2.3.2)。
 *
 * 対応要件: FR-106(クリック選択とホバー)、FR-502(参照は id で持つ)、NFR-UX-1。
 *
 * DOM にも three.js にもストアにも触れない純関数だけを置く(Node で検査できる。
 * `docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して検査する」)。
 *
 * **要素 id の書式はこのファイルの `subShapeElementId` / `parseSubShapeId` の 2 つだけが知る。**
 * 書式の知識を他のファイルへ散らすと、片方だけ直したときに読み書きが食い違うため。
 *
 *     立体              extrude-1
 *     面                extrude-1#face:12
 *     辺                fillet-1#edge:5
 *     頂点              hole-2#vertex:3
 *     点列の1点(P1)    point-1#3        ← 部分形状ではない
 *
 * ストアの `selection` / `hoveredElementId` にはこの id をそのまま入れる(§0.a-0.8)。
 * `packages/ui/src/sketch/featureSummary.ts` の `featureIdOf` は `#` の前を返すので、
 * 「消えたフィーチャーを選択から外す」掃除は 1 行も変えずにそのまま効く。
 */

import type { SolidBody, SubShapeKind, SubShapeRef, Vec3 } from '@pointercad/model';

import type { NumericInputToolId } from '../sketch/numericInput.js';

/**
 * 部分形状の種類。定義は保存形を持つ `@pointercad/model`(part/types.ts)にあり、
 * ここでは輸出し直すだけにする(同じ型を 2 か所で定義しない。
 * `docs/報告記録.md` 2026-09-03 13:05 の⑤)。
 */
export type { SubShapeKind };

/** 選択の種類(§0.a-0.6)。立体そのものを選ぶ状態も含む。 */
export type SelectionKind = SubShapeKind | 'body';

/** 部分形状の要素 id の区切り。スケッチの点列(`point-1#3`)と同じ記号を使う。 */
export const SUB_SHAPE_SEPARATOR = '#';

/** 種類と番号の区切り。`face:12` の `:`。 */
const INDEX_SEPARATOR = ':';

/**
 * 番号の書き方。先頭に 0 を置いた `007` や符号つき `+1`、小数 `1.5` は受け付けない。
 * 同じ部分形状が 2 通りの id を持たないようにするため(id は選択の同一判定に使う)。
 */
const INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** 読み取った部分形状の要素 id。 */
export interface SubShapeId {
  /** そのボディを作ったフィーチャーの id。 */
  readonly bodyFeatureId: string;
  readonly kind: SubShapeKind;
  /** `TopExp.MapShapes_2` の順で数えた 0 始まりの通し番号。 */
  readonly index: number;
}

/**
 * 面 1 枚の素性。当たり判定の範囲表と指紋の材料を兼ねる。
 *
 * **置き場について:** 本来はカーネルが返す値で `@pointercad/model` の `SolidBody` に付いてくるが、
 * 添えるのはタスク10(kernel)とタスク17(model)で、このタスクの着手時点ではまだ無い。
 * そこで P2 の `pickMath.ts` と同じ流儀で「入力の形」だけをここに書く。欄の名前と型は
 * 計画書タスク17 の `SolidFaceEntry` / `SolidEdgeEntry` / `SolidVertexEntry` に合わせてあるので、
 * **タスク17 が同名の型を輸出したら、この 3 つの定義を消して import に差し替えるだけでよい**
 * (呼び出し側の詰め替えは要らない)。
 */
export interface SolidFaceEntry {
  readonly index: number;
  readonly surfaceKind: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'other';
  /** 面積(mm²)。 */
  readonly area: number;
  /** 重心(mm)。 */
  readonly centroid: Vec3;
  /** 平面は法線、円柱・円錐は軸。求まらなければ null。 */
  readonly axis: Vec3 | null;
  /** 円柱・円錐・球の半径(mm)。平面では null。 */
  readonly radius: number | null;
  /** この面の三角形が indices の何番目から何枚あるか。 */
  readonly triangleOffset: number;
  readonly triangleCount: number;
}

/** 辺 1 本の素性。並びは面と同じく `TopExp.MapShapes_2` の順。 */
export interface SolidEdgeEntry {
  readonly index: number;
  readonly curveKind: 'line' | 'circle' | 'ellipse' | 'other';
  /** 長さ(mm)。 */
  readonly length: number;
  /** 中点(mm)。 */
  readonly midpoint: Vec3;
  readonly start: Vec3;
  readonly end: Vec3;
  /** 直線は向き、円は軸。求まらなければ null。 */
  readonly axis: Vec3 | null;
  /** 円の半径(mm)。それ以外は null。 */
  readonly radius: number | null;
  /** この辺の線分が edgePositions の何番目から何本あるか。 */
  readonly segmentOffset: number;
  readonly segmentCount: number;
}

/** 頂点 1 つの素性。位置しか持たない。 */
export interface SolidVertexEntry {
  readonly index: number;
  readonly position: Vec3;
}

/**
 * 部分形状を選ぶために要るものだけを持つボディ。
 * タスク17 で欄が増えた `SolidBody` はこの形をそのまま満たすので、
 * 呼び出し側(タスク22・23)は詰め替えずに渡せる。
 */
export interface SubShapeBody {
  /** ボディの id = それを作ったフィーチャーの id(§0.a-0.5)。 */
  readonly featureId: string;
  readonly mesh: {
    /** 稜線の線分列。線分 1 本あたり 6 個(始点 xyz + 終点 xyz)。 */
    readonly edgePositions: Float32Array;
  };
  readonly faces: readonly SolidFaceEntry[];
  readonly edges: readonly SolidEdgeEntry[];
  readonly vertices: readonly SolidVertexEntry[];
}

/**
 * カーネルが返したボディを、部分形状を選ぶのに要る欄だけへ詰め替える。
 *
 * 置き場をここにしてあるのは、作るのが `SubShapeBody`(この型の正本がここ)だからで、
 * 画面の部品(`Toolbar.tsx`)にあると画面を持たない呼び出し側(その場入力の確定を
 * ストアへ反映する `sketch/commitToStore.ts`)から使えないため(P4b タスク18 で移した)。
 * DOM にも React にも触れないので、そのまま Node で検査できる。
 */
export function subShapeBodiesOf(bodies: readonly SolidBody[]): readonly SubShapeBody[] {
  return bodies.map((body) => ({
    featureId: body.featureId,
    mesh: { edgePositions: body.mesh.edgePositions },
    faces: body.faces,
    edges: body.edges,
    vertices: body.vertices,
  }));
}

/** `extrude-1#face:12` の形の要素 id を作る。番号は 0 以上の整数(一覧の通し番号)。 */
export function subShapeElementId(
  bodyFeatureId: string,
  kind: SubShapeKind,
  index: number,
): string {
  return `${bodyFeatureId}${SUB_SHAPE_SEPARATOR}${kind}${INDEX_SEPARATOR}${index}`;
}

/** 文字列を部分形状の種類へ直す。知らない語なら null(`as` を使わずに絞り込む)。 */
function toSubShapeKind(text: string): SubShapeKind | null {
  switch (text) {
    case 'face':
    case 'edge':
    case 'vertex':
      return text;
    default:
      return null;
  }
}

/**
 * 要素 id を読む。`#` の後が `face:` / `edge:` / `vertex:` で始まり、
 * 番号が 0 以上の整数のときだけ成立する。
 *
 * - スケッチの点列の 1 点(`point-1#3`)は null になる(種類の語が無いため)。
 * - `#` を 2 つ以上含む id(`a#b#face:1`)は受け付けない。フィーチャーの id は `#` を含まず、
 *   受け付けると `featureIdOf`(`#` の前を返す)との対応が崩れるため。
 * - 本体が空の id(`#face:1`)も受け付けない。
 */
export function parseSubShapeId(elementId: string): SubShapeId | null {
  const separator = elementId.indexOf(SUB_SHAPE_SEPARATOR);
  if (separator <= 0) {
    return null;
  }
  const bodyFeatureId = elementId.slice(0, separator);
  const rest = elementId.slice(separator + 1);
  if (rest.includes(SUB_SHAPE_SEPARATOR)) {
    return null;
  }
  const colon = rest.indexOf(INDEX_SEPARATOR);
  if (colon < 0) {
    return null;
  }
  const kind = toSubShapeKind(rest.slice(0, colon));
  const digits = rest.slice(colon + 1);
  if (kind === null || !INDEX_PATTERN.test(digits)) {
    return null;
  }
  const index = Number.parseInt(digits, 10);
  return Number.isSafeInteger(index) ? { bodyFeatureId, kind, index } : null;
}

/** その要素 id が部分形状か。立体・スケッチの要素なら false。 */
export function isSubShapeId(elementId: string): boolean {
  return parseSubShapeId(elementId) !== null;
}

/**
 * 一覧から通し番号の合う 1 件を引く。
 * カーネルは `index` が並び順と同じになるように作る(タスク3・4)ので、まず同じ位置を見て、
 * 食い違ったときだけ探し直す。番号が範囲の外なら null(FR-504 の「見つからない」は呼び出し側が出す)。
 */
function entryAt<T extends { readonly index: number }>(
  entries: readonly T[],
  index: number,
): T | null {
  const direct = entries[index];
  if (direct !== undefined && direct.index === index) {
    return direct;
  }
  return entries.find((entry) => entry.index === index) ?? null;
}

/**
 * ボディの一覧と要素 id から、文書へ保存する参照(指紋つき)を作る(§2.2.2)。
 * ボディが見つからない・番号が範囲の外・部分形状でない id のときは null。
 */
export function subShapeRefOf(
  bodies: readonly SubShapeBody[],
  elementId: string,
): SubShapeRef | null {
  const parsed = parseSubShapeId(elementId);
  if (parsed === null) {
    return null;
  }
  const body = bodies.find((candidate) => candidate.featureId === parsed.bodyFeatureId);
  if (body === undefined) {
    return null;
  }
  switch (parsed.kind) {
    case 'face': {
      const face = entryAt(body.faces, parsed.index);
      return face === null
        ? null
        : {
            bodyFeatureId: body.featureId,
            index: face.index,
            fingerprint: {
              kind: 'face',
              surfaceKind: face.surfaceKind,
              area: face.area,
              position: face.centroid,
              axis: face.axis,
              radius: face.radius,
            },
          };
    }
    case 'edge': {
      const edge = entryAt(body.edges, parsed.index);
      return edge === null
        ? null
        : {
            bodyFeatureId: body.featureId,
            index: edge.index,
            fingerprint: {
              kind: 'edge',
              curveKind: edge.curveKind,
              length: edge.length,
              position: edge.midpoint,
              axis: edge.axis,
              radius: edge.radius,
            },
          };
    }
    case 'vertex': {
      const vertex = entryAt(body.vertices, parsed.index);
      return vertex === null
        ? null
        : {
            bodyFeatureId: body.featureId,
            index: vertex.index,
            fingerprint: { kind: 'vertex', position: vertex.position },
          };
    }
  }
}

/**
 * 選択のうち、指定した種類の部分形状の参照だけを、選んだ順に返す。
 * 引けなかったもの(ボディが消えた・番号が範囲の外)は黙って飛ばす
 * (残っている選択で加工できるほうが、何も作れないより利用者の意図に近い。FR-504 の理由は
 * 再計算のときに出る)。
 */
export function selectedSubShapeRefs(
  bodies: readonly SubShapeBody[],
  selection: readonly string[],
  kind: SubShapeKind,
): readonly SubShapeRef[] {
  const refs: SubShapeRef[] = [];
  for (const elementId of selection) {
    const parsed = parseSubShapeId(elementId);
    if (parsed === null || parsed.kind !== kind) {
      continue;
    }
    const ref = subShapeRefOf(bodies, elementId);
    if (ref !== null) {
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * 選択のうち、立体(部分形状でない)の id だけを選んだ順に返す。
 * いま画面にあるボディ(`liveIds`)に限るので、スケッチの要素 id は混ざらない。
 */
export function selectedBodyIds(
  selection: readonly string[],
  liveIds: readonly string[],
): readonly string[] {
  const live = new Set(liveIds);
  return selection.filter((elementId) => !isSubShapeId(elementId) && live.has(elementId));
}

/**
 * 選択中の部分形状が属するボディの id(§0.a-0.20 の加工の対象を決めるのに使う)。
 * 部分形状が 1 つも無いとき、2 つ以上のボディにまたがるときは null
 * (1 つの加工フィーチャーが対象にできるボディは 1 つだけのため)。
 */
export function commonBodyIdOf(selection: readonly string[]): string | null {
  let common: string | null = null;
  for (const elementId of selection) {
    const parsed = parseSubShapeId(elementId);
    if (parsed === null) {
      continue;
    }
    if (common === null) {
      common = parsed.bodyFeatureId;
    } else if (common !== parsed.bodyFeatureId) {
      return null;
    }
  }
  return common;
}

/**
 * 道具ごとに、何を選ぶか(§0.a-0.6、§2.3.2 の表)。
 *
 * | 道具 | 選ぶもの |
 * |---|---|
 * | 穴・ねじ穴 | 穴をあける面 |
 * | R 面取り・C 面取り | 丸める・面を取る辺(頂点は手動で `1` キーへ切り替える) |
 * | 選択・スケッチの道具・押し出し・回転・縫合・パターン | 立体 |
 * | ばね | 立体(始点にするスケッチの点と軸の線分を選ぶので、部分形状は選ばない。§0.36) |
 *
 * 道具を選んだときにストアがこれで `selectionKind` を切り替える(タスク21)。
 * **この対応表はここ 1 か所だけに置く**(`docs/報告記録.md` 2026-09-03 13:05 の⑤)。
 *
 * タスク24 で加工6種+ばねが `numericInput.ts` の `SolidToolId`(`NumericInputToolId` の一部)へ
 * 入ったので、引数は `NumericInputToolId` 1 本にした(以前あった一時型 `P3SolidToolId` は
 * ここと `useAppStore.ts` から消した。タスク26 での整理、`docs/plans/P3-加工フィーチャー.md`
 * §1 の指示のとおり)。
 */
export function selectionKindForTool(tool: NumericInputToolId): SelectionKind {
  switch (tool) {
    case 'hole':
    case 'threadHole':
      return 'face';
    case 'fillet':
    case 'chamfer':
      return 'edge';
    /*
      基準ジオメトリ(FR-328、FR-329、P4 タスク13)。決め方の選択肢で「辺」「面」「頂点」の
      どれを指すかが変わるので、**その道具で最もよく使う種類**を既定にする(足りなければ
      `1`〜`4` キーか帯の札から切り替えられる)。オフセットは面、点を通る平面と基準軸は辺、
      基準点は頂点をよく使う。3 点の平面・傾け・座標系は何も選ばずに作れるので立体のまま。
    */
    case 'referencePlaneOffset':
      return 'face';
    case 'referencePlaneThroughPoint':
    case 'referenceAxis':
      return 'edge';
    case 'referencePoint':
      return 'vertex';
    /*
      投影(FR-325、P4 タスク27)。写せるのは面の外周と辺の 2 通りで、板の上面・穴の丸い面の
      ように「面の外周をまるごと」写す使い方のほうが多いので既定は面にする。辺 1 本だけを
      写したいときは `2` キーか帯の札で「辺」へ切り替える(基準ジオメトリと同じ考え方)。
      断面(交差)は立体そのものを選ぶ道具なので `body` のまま(既定の分岐へ落ちる)。
    */
    case 'projectedCurve':
      return 'face';
    default:
      return 'body';
  }
}
