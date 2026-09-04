/**
 * 原点の再設定の画面側(FR-331、計画書 docs/plans/P4-スケッチ拡張.md §0.a-0.25 ③・タスク35 ④)。
 *
 * 利用者から見た振る舞いは「点を 1 つ選んで『ここを原点にする』を押すと、その点の座標が
 * 0 になり、ほかのすべての要素が**式のまま**追従する」。文書の書き換えそのものは
 * `@pointercad/model` の `shiftOrigin`(タスク35a)が行い、ここは
 *
 *   選んだ要素 id → 原点にする点の指し方(`OriginTarget`) → 平行移動の量 → 新しい文書と帯の一言
 *
 * の詰め替えだけを受け持つ。DOM にもストアにも触れない純関数だけを置く(Node で検査できる。
 * `docs/報告記録.md` 2026-09-02 23:09「操作の判断は純関数へ切り出して検査する」)。
 *
 * 入り口は 2 つで、どちらもここの `originPickFor` / `applyOriginPick` を呼ぶ
 * (同じ判断を 2 か所に書かない):
 *   - モデルブラウザの行の「⋮」一覧(`shell/FeatureTree.tsx`)
 *   - プロパティのボタン(`shell/PropertyPanel.tsx`)
 * ツールバーには道具を増やさない(§0.a-0.25 ③、利用者の決定 2026-09-04)。
 */

import {
  findReference,
  originShiftFor,
  originShiftFromPosition,
  shiftOrigin,
  type OriginShift,
  type OriginTarget,
  type PartDocument,
  type ResolvedReferences,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import type { TreeRow, TreeSectionKey } from '../solid/solidSummary.js';
import { subShapeRefOf, type SubShapeBody } from '../solid/subShapeSelection.js';

/**
 * 帯の一言に式をそのまま出す上限(文字数)。これを超えたら評価値(`display`)へ落とす。
 *
 * 式のまま出すのが原則(利用者が入れた式が読めるほうが「何がどれだけ動いたか」が分かる)
 * だが、スプラインの制御点のように長い式では帯が読めなくなるため(FR-905)。
 */
const MAX_NOTICE_SOURCE_LENGTH = 60;

/** 帯の一言の差し込み口。`{point}` 1 つだけなので、そこだけを埋める。 */
const POINT_PLACEHOLDER = '{point}';

/**
 * 原点にできる点の選び方。木の行もプロパティのボタンも、まずこれを作れるかどうかで
 * 「ここを原点にする」を出すかを決める。
 */
export interface OriginPick {
  /** model へ渡す点の指し方(式を持つ点は式のまま使われる)。 */
  readonly target: OriginTarget;
  /**
   * 式が復元できなかったとき(極座標・直前の点を基準にした相対など)に使う、
   * 解決済みの世界座標。引けなければ null で、そのときは原点にできない。
   */
  readonly position: Vec3 | null;
  /** ボタン・一覧に出す文言の鍵。立体の頂点だけ言い方を変える(NFR-UX-1)。 */
  readonly labelKey: MessageKey;
}

/** `originPickFor` に渡すもの。すべてストアがそのまま持っている値。 */
export interface OriginPickInput {
  readonly document: PartDocument;
  /** いま編集しているスケッチ(木のスケッチの節に出ているのはこの 1 本)。 */
  readonly sketch: SketchDocument;
  readonly resolvedSketch: ResolvedSketch;
  readonly resolvedReferences: ResolvedReferences;
  readonly bodies: readonly SubShapeBody[];
  /** 選ばれている要素の id(`point-1` / `refPoint-1` / `extrude-1#vertex:3`)。 */
  readonly elementId: string;
}

/**
 * 選ばれている要素 1 つが原点にできる点かを見て、できるならその指し方を返す(FR-331)。
 *
 * 原点にできるのは次の 3 つだけ。線分・円弧・面・立体そのもの、点列の n 番目
 * (`point-1#3`。1 つの座標欄で表せない)は null を返す。
 *   - 立体の頂点(部分形状の参照。式を持たないので解決済みの座標をそのまま使う)
 *   - いま編集しているスケッチの点フィーチャー
 *   - 基準点(FR-329)
 */
export function originPickFor(input: OriginPickInput): OriginPick | null {
  // 立体の頂点。`#vertex:n` の読み取りと一覧の引き当ては subShapeSelection.ts の 1 か所に任せる。
  const reference = subShapeRefOf(input.bodies, input.elementId);
  if (reference !== null) {
    return reference.fingerprint.kind !== 'vertex'
      ? null
      : {
          target: { kind: 'position', position: reference.fingerprint.position },
          position: reference.fingerprint.position,
          labelKey: 'originCommand.vertexAction',
        };
  }

  /*
    スケッチの点。木はいま編集しているスケッチ以外の行も出せる(スケッチが 2 本以上ある文書)
    ので、文書のスケッチ全部から探す。式のまま移すのに要るのは「どのスケッチの何番の点か」
    だけなので、これで足りる。解決済みの位置(式へ復元できないときの後退先)は、いま編集して
    いるスケッチのぶんしかストアに無いので、そのときだけ添える。
  */
  for (const sketch of input.document.sketches) {
    const feature = sketch.features.find((item) => item.id === input.elementId);
    if (feature === undefined) {
      continue;
    }
    return feature.kind !== 'point'
      ? null
      : {
          target: { kind: 'sketchPoint', sketchId: sketch.id, featureId: feature.id },
          position:
            sketch.id !== input.sketch.id
              ? null
              : (input.resolvedSketch.points.find((point) => point.featureId === feature.id)
                  ?.position ?? null),
          labelKey: 'originCommand.action',
        };
  }

  const referenceFeature = findReference(input.document, input.elementId);
  if (referenceFeature !== undefined && referenceFeature.kind === 'referencePoint') {
    return {
      target: { kind: 'referencePoint', featureId: referenceFeature.id },
      position:
        input.resolvedReferences.points.find((point) => point.featureId === referenceFeature.id)
          ?.position ?? null,
      labelKey: 'originCommand.action',
    };
  }
  return null;
}

/**
 * モデルブラウザの行の「⋮」一覧に「ここを原点にする」を出してよいか(P4 タスク33 の一覧)。
 *
 * 一覧は選ぶ前に開くこともある(右クリックで選択と同時に開く)ので、開いた時点で分かる
 * 「行の種類」だけで決める。原点にできるのはスケッチの点フィーチャーと基準点だけで、
 * 立体の頂点は木に行が無いのでプロパティのボタンから行う(§0.a-0.25 ③)。
 */
export function treeRowTakesOrigin(sectionKey: TreeSectionKey, row: TreeRow): boolean {
  if (sectionKey === 'sketch') {
    return row.kind === 'point';
  }
  return sectionKey === 'reference' && row.kind === 'referencePoint';
}

/** 原点を移した結果。呼び出し側は文書を 1 回積んで(Undo 1 段)、一言を帯へ出す。 */
export interface OriginChange {
  readonly document: PartDocument;
  /** 帯に出す一言(FR-905)。 */
  readonly notice: string;
}

/**
 * 平行移動の量を決める(タスク35 ③)。
 *
 * 式を持つ点は式のまま(`originShiftFor`)。極座標・直前の点を基準にした相対のように
 * 式へ復元できない点と、立体の頂点(そもそも式を持たない)は、解決済みの倍精度の座標から
 * 作り直す(`originShiftFromPosition`。丸めない)。どちらでも決まらなければ null。
 */
function originShiftOf(
  document: PartDocument,
  pick: OriginPick,
): { readonly shift: OriginShift; readonly keptExpression: boolean } | null {
  // 立体の頂点(`position`)は式を持たないので、`originShiftFor` が返す式も数値の式になる。
  const keptExpression = pick.target.kind !== 'position';
  const fromExpression = keptExpression ? originShiftFor(document, pick.target) : null;
  if (fromExpression !== null) {
    return { shift: fromExpression, keptExpression: true };
  }
  return pick.position === null
    ? null
    : { shift: originShiftFromPosition(pick.position), keptExpression: false };
}

/**
 * 選んだ点を原点にした新しい文書と、帯の一言を作る(FR-331)。
 *
 * 履歴に段は増えない(式を書き換えるだけ、利用者の決定 2026-09-04)。呼び出し側が
 * `applyDocument` へ 1 回渡せば Undo 1 回で戻る。決められないときは null。
 */
export function applyOriginPick(document: PartDocument, pick: OriginPick): OriginChange | null {
  const resolved = originShiftOf(document, pick);
  if (resolved === null) {
    return null;
  }
  return {
    document: shiftOrigin(document, resolved.shift),
    notice: originNoticeText(resolved.shift, resolved.keptExpression),
  };
}

/**
 * ストアが持っている値のうち、原点の再設定に要るものだけ。ストア(`AppState`)はこの形を
 * そのまま満たすので、呼び出し側は詰め替えずに `useAppStore.getState()` を渡せる。
 */
export type OriginCommandState = Omit<OriginPickInput, 'elementId'>;

/**
 * 要素 id 1 つから、原点を移した文書と帯の一言までを一息に作る(FR-331)。
 *
 * 木の「⋮」一覧とプロパティのボタンが同じこれを呼ぶ(同じ手順を 2 か所に書かない)。
 * 原点にできない要素・位置が計算できていない点では null を返し、呼び出し側は断りを帯へ出す。
 */
export function originChangeFor(state: OriginCommandState, elementId: string): OriginChange | null {
  const pick = originPickFor({ ...state, elementId });
  return pick === null ? null : applyOriginPick(state.document, pick);
}

/**
 * 帯に出す一言(FR-905)。「原点を (10 + π/2, 3, 0) から移しました。」のように、
 * **もとの原点がいまどこにあるか**(= 動かした量)を式のまま伝える。
 *
 * 式が長すぎて帯に収まらないときは評価値へ落とす。式へ復元できずに数値で移したときは、
 * そのことを添える(利用者が後から式を直せないため。NFR-UX-5)。
 */
export function originNoticeText(shift: OriginShift, keptExpression: boolean): string {
  const separator = t('originCommand.pointSeparator');
  const sources = [shift.x.source, shift.y.source, shift.z.source].join(separator);
  const point =
    sources.length <= MAX_NOTICE_SOURCE_LENGTH
      ? sources
      : [shift.x.display, shift.y.display, shift.z.display].join(separator);
  const template = t(
    keptExpression ? 'originCommand.movedNotice' : 'originCommand.movedNumericNotice',
  );
  return template.split(POINT_PLACEHOLDER).join(point);
}
