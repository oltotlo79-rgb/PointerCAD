/** 部品 JSON: 選択セット。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  fieldProblem,
  indexPath,
  joinPath,
  readArray,
  readLiteral,
  readString,
} from '../guards.js';
import {
  readList,
} from './fields.js';
import {
  readSubShapeRefField,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type SelectionMember,
  type SelectionSet,
} from '@pointercad/model';

/**
 * 選択セットの要素(FR-112、P6 §0.a-0.44、タスク37)。**外観の割り当て先より 2 語多い。**
 *
 * 利用者の決定(2026-09-06)で選択セットは辺・頂点も覚えるようになった(選択フィルタの
 * 4 つの入切と対になる。§0.a-0.43)。外観は色を塗る先が面なので `'edge'` / `'vertex'` を
 * 受け付けてはならず、一覧を分けてある。**欄も書式の版も増えていない**(版7 のまま)ので、
 * 立体・面だけの既存の版7 のファイルはそのまま読める。
 */
const SELECTION_MEMBER_KINDS: readonly SelectionMember['kind'][] = [
  'body',
  'face',
  'edge',
  'vertex',
];

/**
 * 選択セットの要素 1 つ(`SelectionMember`、FR-112、版7、P6 タスク37)。
 *
 * **外観の割り当て先(`AppearanceTarget`)とは別の型になった**(利用者の決定、2026-09-06)。
 * 立体と面だけでなく**辺と頂点も覚える**ので書き手を分ける。`ref` の中身は P3 の
 * `serializeSubShapeRef`(指紋つき)をそのまま使い回すため、増えるのは `kind` に入る語
 * (`'edge'` / `'vertex'`)だけで、**欄は 1 つも増えず書式の版も上がらない**(版7 のまま)。
 * 立体・面だけの既存の版7 のファイルは 1 バイトも変わらない。
 */
function serializeSelectionMember(member: SelectionMember): SelectionMember {
  if (member.kind === 'body') {
    return { kind: 'body', bodyFeatureId: member.bodyFeatureId };
  }
  // 判別子は指紋の種類から採る。`ref` の中身と食い違った値を書き出さないため
  // (読み手はこの 2 つが一致していることを確かめて、食い違えば断る)。
  return { kind: member.ref.fingerprint.kind, ref: serializeSubShapeRef(member.ref) };
}

/** 選択セット 1 つ(FR-112、版7、P6 タスク37)。 */
export function serializeSelectionSet(set: SelectionSet): SelectionSet {
  return {
    id: set.id,
    name: set.name,
    members: set.members.map(serializeSelectionMember),
  };
}

/**
 * 選択セットの要素 1 つ(`SelectionMember`、FR-112、版7、P6 タスク37)を読む。
 *
 * 立体・面・辺・頂点の 4 種(利用者の決定、2026-09-06)。`ref` の中身は P3 の
 * `readSubShapeRefField`(指紋つき)をそのまま使い回すので、外観の読み手との違いは
 * **受け付ける `kind` の語が 2 つ多いことだけ**である。知らない語(`'edgeLoop'` 等)は
 * `readLiteral` が場所を添えて断る(エラーコードは増やさず `invalidField` のまま)。
 *
 * **判別子と指紋の種類が食い違うファイルは断る。** `kind: 'edge'` なのに `ref.fingerprint`
 * が面、という組み合わせは書き手が作らない(`serializeSelectionMember` は指紋から
 * 判別子を採る)ので、届いたら壊れたファイルである。そのまま読むと画面が
 * `extrude-1#edge:3` という要素 id を面に対して作ってしまい、選び直せない組が残る。
 */
function readSelectionMemberRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<SelectionMember> {
  const kind = readLiteral(record, 'kind', path, SELECTION_MEMBER_KINDS);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === 'body') {
    const bodyFeatureId = readString(record, 'bodyFeatureId', path);
    if (!bodyFeatureId.ok) {
      return bodyFeatureId;
    }
    return { ok: true, value: { kind: 'body', bodyFeatureId: bodyFeatureId.value } };
  }
  const ref = readSubShapeRefField(record, 'ref', path);
  if (!ref.ok) {
    return ref;
  }
  if (ref.value.fingerprint.kind !== kind.value) {
    return fieldProblem(joinPath(path, 'kind'), 'type');
  }
  return { ok: true, value: { kind: kind.value, ref: ref.value } };
}

/**
 * 選択セット 1 つ(FR-112、版7、P6 タスク37)を読む。
 *
 * **名前が空かどうかはここでは見ない。** 空にできないのは利用者の操作の話(model の
 * `createSelectionSet` が断る)で、壊れたファイルの判定ではないため、ここで断ると
 * 「開けないファイル」を作ってしまう(FR-504「読み込みでファイルを失わせない」)。
 * **同じ名前が 2 つあっても読む**(§2.13。区別は id が付ける)。
 */
function readSelectionSetItem(value: unknown, path: string): Checked<SelectionSet> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const name = readString(record.value, 'name', path);
  if (!name.ok) {
    return name;
  }
  const array = readArray(record.value, 'members', path);
  if (!array.ok) {
    return array;
  }
  const membersPath = joinPath(path, 'members');
  const members: SelectionMember[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const itemPath = indexPath(membersPath, index);
    const item = checkRecord(array.value[index], itemPath);
    if (!item.ok) {
      return item;
    }
    const member = readSelectionMemberRecord(item.value, itemPath);
    if (!member.ok) {
      return member;
    }
    members.push(member.value);
  }
  return { ok: true, value: { id: id.value, name: name.value, members } };
}

/**
 * 選択セット(FR-112)を読む。**版7からは必須**(欠けていれば `missingField`)。
 * 版6以前のこの欄が無いファイルは `schema.ts` の `SCHEMA_MIGRATIONS[6]`(欄が無ければ
 * 空配列で補う)へ移す。書き手は常にこの欄を書く。
 */
export function readSelectionSets(
  record: Record<string, unknown>,
  path: string,
): Checked<readonly SelectionSet[]> {
  return readList(record, 'selectionSets', path, readSelectionSetItem);
}
