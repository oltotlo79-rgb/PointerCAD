/**
 * 選択セット(FR-112「選んだ組に名前を付けて保存・呼び出しできる」)の、
 * 画面と文書のあいだを取り持つ純関数(計画書 docs/plans/P6-入出力.md §0.a-0.44、
 * §2.13、タスク43)。
 *
 * 対応要件: FR-112(選んだ組に名前を付ける・呼び出す)、FR-504(できないことは警告して
 * 止めない)、NFR-UX-5(押す前に理由を示す)。
 *
 * **DOM にも three.js にもストアにも触れない**(Node で検査できる)。組み立ての本体は
 * model の `part/selectionSets.ts`(`createSelectionSet` ほか)が持っていて、ここが受け持つのは
 * **画面の言葉と文書の言葉のあいだの翻訳だけ**である。
 *
 * | 向き | 何をするか |
 * |---|---|
 * | 画面 → 文書 | いま選んでいる要素 id(`extrude-1#face:3`)を `SelectionMember` へ写す |
 * | 文書 → 画面 | 覚えてある `SelectionMember` を、いまの形の要素 id へ戻す |
 *
 * **覚えられるのは立体・面・辺・頂点の 4 種**(利用者の決定、2026-09-06)。要素 id の
 * `#face:` / `#edge:` / `#vertex:` の語と、文書の `SelectionMember` の判別子は同じ綴りなので、
 * 写し取りに対応表は要らない(`subShapeElementId` / `parseSubShapeId` がそのまま使える)。
 * 「辺・頂点は覚えられません」という断りはもう無い。
 *
 * **形は変えない。** 選択セットは `PartDocument.selectionSets` にしか触れないので
 * `affectsShape`(model の `part/documentChange.ts`)が偽になり、再計算も `isComputing` の札も
 * 動かない(§0.a-0.44。ストアの検査でそれを固定する)。
 *
 * **断りの日本語はここに書かない**(NFR-MA-5)。model が返した理由のコードを `ja.json` の鍵へ
 * 写すだけにして、同じ日本語を 2 か所に置かない。
 */

import { createSubShapeReferenceResolver, type SelectionMember, type SelectionSet, type SelectionSetRefusal,
  type SolidBody, type SubShapeRef } from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';

import {
  parseSubShapeId,
  subShapeElementId,
  subShapeRefOf,
  type SelectionKind,
  type SubShapeBody,
} from './subShapeSelection.js';

/**
 * いま選んでいるものを `SelectionMember` の一覧へ写す(FR-112)。
 *
 * **立体・面・辺・頂点の 4 種すべてを覚える**(利用者の決定、2026-09-06)。選択フィルタ
 * (§0.a-0.43)がこの 4 つを入切する以上、覚えられるのも同じ 4 つでなければ
 * 「切れるのに覚えられない種類」ができてしまう。辺・頂点の指紋(`SubShapeRef`)も
 * 面と同じ仕組みで作れる(`subShapeRefOf` が 3 種すべてを受け持つ)。
 *
 * **選んだ順を保つ。** 面だけ・立体だけに寄せず、混ざっていればすべて入れる
 * (外観の `appearanceTargetsOf` は「面が選ばれていれば面だけ」に寄せるが、あれは
 * 「どこへ色を塗るか」を 1 つに決める必要があるためで、名前を付けて覚える組には
 * その必要が無い。利用者が選んだものをそのまま覚えるほうが意図に近い)。
 *
 * **いま画面に無いものは入れない。** 消えたフィーチャーの id が選択に残っていることは
 * 通常は無い(`documentPatch` が掃除する)が、ここで確かめておけば「開いた直後に
 * 覚えたはずのものが引けない」組を作らずに済む。スケッチの要素 id(`line-1`、
 * `point-1#3`)も立体の一覧に無いので自然に落ちる。
 *
 * 重複はここでは落とさない(model の `createSelectionSet` / `addSelectionSetMembers` が
 * 同じ判定で落とす。同じ約束を 2 か所に置かない)。
 */
export function selectionMembersOf(
  bodies: readonly SubShapeBody[],
  selection: readonly string[],
  vertexReferences?: ReadonlyMap<string, SubShapeRef>,
): readonly SelectionMember[] {
  const members: SelectionMember[] = [];
  for (const elementId of selection) {
    const parsed = parseSubShapeId(elementId);
    if (parsed === null) {
      // 部分形状でない id は立体そのもの(またはスケッチの要素)。生きている立体だけを入れる。
      if (bodies.some((body) => body.featureId === elementId)) {
        members.push({ kind: 'body', bodyFeatureId: elementId });
      }
      continue;
    }
    const ref = parsed.kind === 'vertex' && vertexReferences !== undefined
      ? vertexReferences.get(elementId) ?? null : subShapeRefOf(bodies, elementId);
    if (ref !== null && ref.fingerprint.kind === parsed.kind && ref.bodyFeatureId === parsed.bodyFeatureId) {
      // 判別子は指紋の種類から採る(`ref` の中身と食い違った員を作らない。io が断る形)。
      members.push({ kind: ref.fingerprint.kind, ref });
    }
  }
  return members;
}

/** 覚えてある組を、いまの形の要素 id へ戻した結果。 */
export interface SelectionSetElementIds {
  /** そのまま `setSelection` へ渡せる要素 id。 */
  readonly elementIds: readonly string[];
  /**
   * いまの形から引けなかった要素の数(FR-504)。**組そのものは残す**ので、
   * 画面は「n 件は見つかりませんでした」と知らせるだけでよい(§2.13)。
   */
  readonly missingCount: number;
  readonly references: readonly ResolvedSelectionSetReference[];
}

/** The saved reference and its current unique match travel together to selection state. */
export interface ResolvedSelectionSetReference {
  readonly elementId: string;
  readonly originalReference: SubShapeRef;
  readonly matchedReference: SubShapeRef;
}

/**
 * 覚えてある組を、いまの形の要素 id へ戻す(FR-112「呼び出せる」)。
 *
 * 共通の参照解決で一意に一致した現在の番号だけを採用する。保存した組の指紋と番号は
 * 書き換えない。古い番号に別の形が存在しても、それだけでは一致とみなさない。
 *
 * 立体が消えている・その番号の面がもう無いときは**その 1 件だけを飛ばして数える**。
 * 引けたものは選べたほうが、何も選べないより利用者の意図に近い(FR-504、NFR-RE-1)。
 */
export function selectionSetElementIds(
  bodies: readonly SolidBody[],
  set: SelectionSet,
): SelectionSetElementIds {
  const elementIds: string[] = [];
  const references: ResolvedSelectionSetReference[] = [];
  const resolve = createSubShapeReferenceResolver();
  let missingCount = 0;
  for (const member of set.members) {
    if (member.kind === 'body') {
      if (bodies.filter(body => body.featureId === member.bodyFeatureId && body.isValid).length === 1) {
        elementIds.push(member.bodyFeatureId);
      } else {
        missingCount += 1;
      }
      continue;
    }
    const matches = bodies.filter(candidate => candidate.featureId === member.ref.bodyFeatureId && candidate.isValid);
    const resolution = matches.length === 1 && member.ref.fingerprint.kind === member.kind
      ? resolve(matches[0], member.ref) : null;
    if (resolution?.status !== 'matched' || resolution.match.geometry.kind !== member.kind) {
      missingCount += 1;
      continue;
    }
    const matchedReference = resolution.match.reference;
    const elementId = subShapeElementId(matchedReference.bodyFeatureId, member.kind, matchedReference.index);
    elementIds.push(elementId);
    references.push({ elementId, originalReference: member.ref, matchedReference });
  }
  return { elementIds, missingCount, references };
}

/**
 * その組を選び直すときに切り替える「選ぶもの」の種類(§0.a-0.6)。
 *
 * **最初に見つかった部分形状の種類を採る。** 選ぶ種類がその部分形状に合っていないと
 * ビューポートで強調が出ず、選ばれているのに光らない状態になる
 * (`filterPickCandidates` と同じ理屈)。立体だけの組と空の組は `body`(既定)。
 *
 * 種類が混ざった組(面と辺)ではどれか 1 つしか選べないので、**利用者が最初に選んだもの
 * の種類**に合わせる。組の中の並びは選んだ順のまま(`selectionMembersOf`)なので、
 * これは「その組を作ったときに最初に指したもの」と一致する。数の多いほうを採る手も
 * あるが、同数のときにどちらとも決められず、規則が読めなくなるため採らない。
 */
export function selectionKindForSet(set: SelectionSet): SelectionKind {
  const subShape = set.members.find((member) => member.kind !== 'body');
  return subShape === undefined ? 'body' : subShape.kind;
}

/**
 * 組を作れなかった理由を `ja.json` の鍵へ写す(NFR-MA-5)。
 *
 * 名前が空のときの「名前を入れてください。」は**パラメータ表の名前の検査と同じ文**で、
 * `ja.json` に `parameter.error.empty` として既にある。model の `selectionSets.ts` の冒頭が
 * 「同じ日本語を 2 か所に置かない」と書いているとおり、鍵を増やさずそれを引く。
 *
 * 理由が増えたら `switch` が型検査で落ちるので、鍵の追加を忘れない。
 */
export function selectionSetRefusalMessageKey(reason: SelectionSetRefusal): MessageKey {
  switch (reason) {
    case 'emptyName':
      return 'parameter.error.empty';
  }
}
