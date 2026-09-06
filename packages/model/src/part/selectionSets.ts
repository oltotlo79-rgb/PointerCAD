/**
 * 選択セットの組み立て(FR-112「選んだ組に名前を付けて保存・呼び出しできる」)。
 * 計画書 docs/plans/P6-入出力.md §0.a-0.44、§2.13、タスク37。
 *
 * ここに置くのは**純関数だけ**で、DOM にも React にもカーネルにも触れない。
 * セットは不変の配列として持ち、足す・消す・名前を変えるたびに新しい配列を作る
 * (`appearance/appearanceTable.ts` と `part/createPartDocument.ts` の流儀。
 * 変わらなかったときは元の配列を**同一参照のまま**返し、無駄な作り直しをしない)。
 *
 * **同じ参照を返すことには意味がある。** `part/documentChange.ts` の `affectsShape` は
 * 欄の参照の不一致だけを見るので、「何も変わっていない」を同一参照で表しておくと、
 * 上の層が余計な文書の差し替えをしなくて済む。
 *
 * **断りはコードだけを返し、日本語の文言は持たない**(NFR-MA-5)。名前が空のときの
 * 「名前を入れてください。」は `packages/ui` の `ja.json` に既にある文
 * (`parameter.error.empty`)とまったく同じ文なので、同じ日本語を 2 か所に置かない
 * (パラメータ表の名前の検査が `packages/expression` の `VariableNameIssue` という
 * コードを返し、ui が文言を持っているのと同じ形にそろえてある)。
 */

import { isSameSubShape } from '../geometry/subShapeRef.js';

import type { SelectionMember, SelectionSet } from './types.js';

/**
 * 選択セットの id の接頭辞。採番は「同じ接頭辞の既存 id の最大連番 + 1」
 * (`nextAppearanceId` と同じ規則。1 つ消しても残りの最大の次になるので重ならない)。
 */
const SELECTION_SET_ID_PREFIX = 'selectionSet-';

/**
 * 同じものを指しているか。
 *
 * **外観の割り当て先の判定(`isSameAppearanceTarget`)は借りない**(利用者の決定、
 * 2026-09-06 で型を分けたため)。借りると、外観が扱わない辺・頂点を渡したときに
 * 型の上では通るのに黙って `false` になり、同じ辺を 2 回入れられてしまう。
 *
 * 立体は id が一致するか、部分形状は指紋の同一判定(`isSameSubShape`。ボディ・種類・
 * 通し番号が一致するか)で見る。**指紋の中身(大きさ・位置・軸)は見ない**のは
 * `isSameSubShape` の注釈のとおりで、選び直しの後に値がわずかに変わっても
 * 「同じものを指し続けている」と扱う。
 */
export function isSameSelectionMember(a: SelectionMember, b: SelectionMember): boolean {
  if (a.kind === 'body' || b.kind === 'body') {
    return a.kind === 'body' && b.kind === 'body' && a.bodyFeatureId === b.bodyFeatureId;
  }
  // 種類の食い違い(面と辺)は `isSameSubShape` が指紋の種類で落とすが、判別子どうしも
  // 突き合わせておく。指紋と判別子が食い違ったものは io が読むときに断るので、
  // ここまで届くのは両方そろっている値だけである。
  return a.kind === b.kind && isSameSubShape(a.ref, b.ref);
}

/** セットを作れなかった理由(§2.13 の表)。文言は `packages/ui` が持つ。 */
export type SelectionSetRefusal =
  /** 名前が空(空白だけも空とみなす)。FR-112 は名前で呼び出すので、名無しは作れない。 */
  'emptyName';

/** セットを作った結果。作れたときは新しい配列と、採番したセットそのものを返す。 */
export type CreateSelectionSetResult =
  | { readonly ok: true; readonly sets: readonly SelectionSet[]; readonly set: SelectionSet }
  | { readonly ok: false; readonly reason: SelectionSetRefusal };

/** 名前を変えた結果。 */
export type RenameSelectionSetResult =
  | { readonly ok: true; readonly sets: readonly SelectionSet[] }
  | { readonly ok: false; readonly reason: SelectionSetRefusal };

/**
 * 名前として使える形に整える。前後の空白を落とし、**空になったら null**(断る)。
 *
 * 空白を落とすのは、見た目が同じ名前(`上面` と `上面 `)が一覧に並ぶと利用者が
 * 区別できないためである。**空白を落とした後で同じ名前になっても許す**
 * (§2.13「同じ名前を 2 つ ── 許す(id で区別する)」)。
 */
function normalizeName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 次のセットの id を作る(`selectionSet-<n>`)。既存の id のうちこの形のものの
 * 最大連番 + 1 を採る。
 */
export function nextSelectionSetId(sets: readonly SelectionSet[]): string {
  let max = 0;
  for (const set of sets) {
    if (!set.id.startsWith(SELECTION_SET_ID_PREFIX)) {
      continue;
    }
    const serial = Number(set.id.slice(SELECTION_SET_ID_PREFIX.length));
    if (Number.isInteger(serial) && serial > max) {
      max = serial;
    }
  }
  return `${SELECTION_SET_ID_PREFIX}${String(max + 1)}`;
}

/** id からセットを引く。無ければ `undefined`。 */
export function findSelectionSet(
  sets: readonly SelectionSet[],
  id: string,
): SelectionSet | undefined {
  return sets.find((set) => set.id === id);
}

/** 一覧の中で同じものを 2 回持たないようにする(先に出たほうを残す)。 */
function dedupeMembers(members: readonly SelectionMember[]): readonly SelectionMember[] {
  const kept: SelectionMember[] = [];
  for (const member of members) {
    if (!kept.some((existing) => isSameSelectionMember(existing, member))) {
      kept.push(member);
    }
  }
  return kept;
}

/**
 * セットを作る(FR-112)。**空のセットも作れる**(§2.13。先に名前だけ決めて、
 * 後から `addSelectionSetMembers` で足す使い方を許す)。
 * 名前が空(空白だけを含む)のときだけ断る。
 */
export function createSelectionSet(
  sets: readonly SelectionSet[],
  name: string,
  members: readonly SelectionMember[] = [],
): CreateSelectionSetResult {
  const normalized = normalizeName(name);
  if (normalized === null) {
    return { ok: false, reason: 'emptyName' };
  }
  const set: SelectionSet = {
    id: nextSelectionSetId(sets),
    name: normalized,
    members: dedupeMembers(members),
  };
  return { ok: true, sets: [...sets, set], set };
}

/**
 * セットの名前を変える(FR-112)。**同じ名前が既にあっても許す**(§2.13)。
 * id が見つからなければ元の配列を同一参照のまま返す(`ok: true`。名前の検査は先に通す)。
 */
export function renameSelectionSet(
  sets: readonly SelectionSet[],
  id: string,
  name: string,
): RenameSelectionSetResult {
  const normalized = normalizeName(name);
  if (normalized === null) {
    return { ok: false, reason: 'emptyName' };
  }
  const existing = findSelectionSet(sets, id);
  if (existing === undefined || existing.name === normalized) {
    return { ok: true, sets };
  }
  return {
    ok: true,
    sets: sets.map((set) => (set.id === id ? { ...set, name: normalized } : set)),
  };
}

/** セットを 1 つ消す。見つからなければ元の配列を同一参照のまま返す。 */
export function removeSelectionSet(
  sets: readonly SelectionSet[],
  id: string,
): readonly SelectionSet[] {
  if (!sets.some((set) => set.id === id)) {
    return sets;
  }
  return sets.filter((set) => set.id !== id);
}

/**
 * セットへ要素を足す(FR-112「後から足せる」)。**既に入っているものは足さない**
 * (同じ面を 2 回選んでも 1 件のまま)。何も増えなければ元の配列を同一参照のまま返す。
 */
export function addSelectionSetMembers(
  sets: readonly SelectionSet[],
  id: string,
  members: readonly SelectionMember[],
): readonly SelectionSet[] {
  const existing = findSelectionSet(sets, id);
  if (existing === undefined) {
    return sets;
  }
  const added = members.filter(
    (member) => !existing.members.some((kept) => isSameSelectionMember(kept, member)),
  );
  const unique = dedupeMembers(added);
  if (unique.length === 0) {
    return sets;
  }
  return sets.map((set) =>
    set.id === id ? { ...set, members: [...set.members, ...unique] } : set,
  );
}

/**
 * セットから要素を外す。**セットそのものは残る**(0 件になっても消さない。§2.13 の
 * 「面が消えた ── 警告してその 1 件をセットから外す(セットは残る)」と同じ扱い)。
 * 何も減らなければ元の配列を同一参照のまま返す。
 */
export function removeSelectionSetMembers(
  sets: readonly SelectionSet[],
  id: string,
  members: readonly SelectionMember[],
): readonly SelectionSet[] {
  const existing = findSelectionSet(sets, id);
  if (existing === undefined) {
    return sets;
  }
  const kept = existing.members.filter(
    (member) => !members.some((target) => isSameSelectionMember(member, target)),
  );
  if (kept.length === existing.members.length) {
    return sets;
  }
  return sets.map((set) => (set.id === id ? { ...set, members: kept } : set));
}

/** 掃除の結果。外した件数を返し、上の層が「何件外したか」の警告を出せるようにする。 */
export interface PruneSelectionSetsResult {
  readonly sets: readonly SelectionSet[];
  /** 外した要素の数(0 なら `sets` は元の配列と同一参照)。 */
  readonly removedCount: number;
}

/**
 * 消えたボディを指す要素をセットから外す(§2.13「面が消えた ── 警告してその 1 件を
 * セットから外す。セットは残る」、FR-504、NFR-RE-1)。
 *
 * `appearance/appearanceTable.ts` の `pruneAppearance` と同じ判定(要素が指している
 * ボディの id が `liveBodyIds` に無ければ外す)を使うが、**外観と違ってセットごとは
 * 消さない。** 外観は「そのボディの色」なのでボディが消えれば意味を失うが、選択セットは
 * 利用者が名前を付けた入れ物であり、中身が全部消えても名前と id は残しておいたほうが
 * 選び直して足せる(FR-112)。
 *
 * **部分形状そのものが選び直せなかったとき**(ボディは生きているが指紋が外れたとき)は、
 * ここではなくカーネルとの照合(P5 の `appearanceMatches` と同じ仕組み)が判断する。
 * model は「ボディが消えた」だけを見る。
 *
 * **種類は問わない。** 立体・面・辺・頂点のどれであっても、指しているボディの id を
 * 取り出して生死を見るだけなので、判定は 1 本で足りる(利用者の決定、2026-09-06)。
 */
export function pruneSelectionSets(
  sets: readonly SelectionSet[],
  liveBodyIds: readonly string[],
): PruneSelectionSetsResult {
  const live = new Set(liveBodyIds);
  let removedCount = 0;
  const pruned = sets.map((set) => {
    const kept = set.members.filter((member) =>
      live.has(member.kind === 'body' ? member.bodyFeatureId : member.ref.bodyFeatureId),
    );
    if (kept.length === set.members.length) {
      return set;
    }
    removedCount += set.members.length - kept.length;
    return { ...set, members: kept };
  });
  return removedCount === 0 ? { sets, removedCount: 0 } : { sets: pruned, removedCount };
}
