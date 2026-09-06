/**
 * 選択フィルタ(FR-112)の純関数(計画書 docs/plans/P6-入出力.md §2.13、§0.43、タスク36)。
 *
 * 対応要件: FR-112(選べる種類を絞る)、NFR-PF-1(60fps。切替は 1 コマの中)、
 * NFR-UX-5(何も選べない状態は理由を示す)。
 *
 * **three.js にも DOM にもストアにも触れない**(Node で検査できる)。当たり判定そのものは
 * `pickSubShape.ts` / `createSolidLayer.ts` が行い、ここはその**候補の一覧を絞るだけ**。
 * ホバーの強調も選択も同じ候補の一覧を通るので、絞る場所を 1 つにしておけば
 * 「押せば選べるのにホバーの色は出ない」といった食い違いが起きない(タスク36 手順3)。
 *
 * **形は変えない。** 絞った結果は選択とホバーにしか効かず、`affectsShape` の経路には
 * 乗らない(再計算を起こさない、rules/04)。設定は端末に覚える(`settings.ts`)。
 */

import type { MessageKey } from '../i18n/t.js';

import type { SelectionKind } from './subShapeSelection.js';

/**
 * 選べる種類の入切(FR-112)。4 つとも独立に切り替えられる。
 *
 * 欄の名前は `SelectionKind`(`'vertex' | 'edge' | 'face' | 'body'`)と同じ綴りにしてあり、
 * 種類から欄を引くのに対応表を作らずに済む(`isSelectableKind`)。
 */
export interface SelectionFilter {
  readonly vertex: boolean;
  readonly edge: boolean;
  readonly face: boolean;
  readonly body: boolean;
}

/**
 * 画面に並べる順(小さいものから大きいものへ)。ステータスバーの入切も、
 * 検査の網羅もこの 1 つの並びを見る(順序を 2 か所に書かない)。
 */
export const SELECTION_FILTER_KINDS: readonly SelectionKind[] = ['vertex', 'edge', 'face', 'body'];

/**
 * 種類の札(§0.a-0.6、FR-112)。**この 1 つが正本**で、ステータスバーの「選ぶもの」の札
 * (`shell/statusText.ts`)も選択フィルタの入切(`shell/StatusBar.tsx`)も同じ表を引く。
 * 種類が増えたら型検査がここを落とすので、札の文言を足し忘れない(文言は ja.json、NFR-MA-5)。
 */
export const SELECTION_KIND_LABEL_KEYS = {
  vertex: 'selection.kind.vertex',
  edge: 'selection.kind.edge',
  face: 'selection.kind.face',
  body: 'selection.kind.body',
} as const satisfies Record<SelectionKind, MessageKey>;

/**
 * 既定は**全部入**(§0.43)。P4b までの操作を 1 つも変えないための出発点で、
 * 保存された値が壊れているときの戻り先でもある。
 */
export const ALL_SELECTABLE: SelectionFilter = {
  vertex: true,
  edge: true,
  face: true,
  body: true,
};

/**
 * 当たり判定の候補 1 件。**要素 id と種類だけ**を見る(位置や距離は絞り込みに要らない)。
 * `pickSubShape.ts` の `SubShapePickResult` は `kind` と `elementId` を持つので、
 * そのまま `filterPickCandidates` へ渡せる。
 */
export interface PickCandidate {
  readonly elementId: string;
  readonly kind: SelectionKind;
}

/** その種類が選べるか(FR-112)。 */
export function isSelectableKind(filter: SelectionFilter, kind: SelectionKind): boolean {
  return filter[kind];
}

/** 4 つとも入か(= P4b までとまったく同じ振る舞い)。 */
export function isAllSelectable(filter: SelectionFilter): boolean {
  return SELECTION_FILTER_KINDS.every((kind) => filter[kind]);
}

/** 4 つとも切か(何も選べない。ステータスバーで理由を出す、NFR-UX-5)。 */
export function isNoneSelectable(filter: SelectionFilter): boolean {
  return SELECTION_FILTER_KINDS.every((kind) => !filter[kind]);
}

/**
 * 当たり判定の候補から、切ってある種類のものを外す(§2.13)。
 *
 * **1 件も減らないときは受け取った一覧をそのまま返す**(同一参照)。既定(全部入)では
 * 配列を 1 つも作らないので、絞り込みを常に通しても費用が増えない(NFR-PF-1)。
 * 呼び出し側は「参照が同じなら何も絞られていない」と見分けられる。
 */
export function filterPickCandidates<Candidate extends { readonly kind: SelectionKind }>(
  candidates: readonly Candidate[],
  filter: SelectionFilter,
): readonly Candidate[] {
  if (candidates.every((candidate) => filter[candidate.kind])) {
    return candidates;
  }
  return candidates.filter((candidate) => filter[candidate.kind]);
}

/** 1 つの種類の入切をひっくり返した新しいフィルタ(ステータスバーの札が使う)。 */
export function toggleSelectionFilter(
  filter: SelectionFilter,
  kind: SelectionKind,
): SelectionFilter {
  return { ...filter, [kind]: !filter[kind] };
}

/**
 * 保存されていた値が選択フィルタの形か(`settings.ts` の読み込みが使う)。
 *
 * 4 欄すべてが真偽であることを求める。1 つでも欠けていれば偽を返し、呼び出し側が
 * **この欄だけ**既定(全部入)へ戻す(欄ごとの後退。`settings.ts` の `readTrackAngleStep`
 * と同じ前方互換の理由)。
 */
export function isSelectionFilter(value: unknown): value is SelectionFilter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'vertex' in value &&
    typeof value.vertex === 'boolean' &&
    'edge' in value &&
    typeof value.edge === 'boolean' &&
    'face' in value &&
    typeof value.face === 'boolean' &&
    'body' in value &&
    typeof value.body === 'boolean'
  );
}
