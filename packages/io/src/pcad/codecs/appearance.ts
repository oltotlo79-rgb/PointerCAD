/** 部品 JSON: 外観。documentJson.ts への逆向きの依存を持たない。 */

import {
  type Checked,
  checkRecord,
  type ExpressionValueJson,
  fieldProblem,
  indexPath,
  joinPath,
  readArray,
  readExpression,
  readLiteral,
  readRecord,
  readString,
} from '../guards.js';
import {
  readKnownLiteralOrNull,
  serializeExpression,
} from './fields.js';
import {
  readSubShapeRefField,
  serializeSubShapeRef,
} from './shapeReferences.js';
import {
  type AppearanceEntry,
  type AppearancePattern,
  type AppearancePresetId,
  type AppearanceSpec,
  type AppearanceTable,
  type AppearanceTarget,
  type WoodSpecies,
} from '@pointercad/model';

// ---------------------------------------------------------------------------
// P5(FR-1106〜1110、要件§4.12、タスク5)が足す外観の割り当ての判別の一覧
// ---------------------------------------------------------------------------

/** 外観の割り当て先(§2.2.1)。立体はフィーチャー id、面は部分形状の参照。 */
const APPEARANCE_TARGET_KINDS: readonly AppearanceTarget['kind'][] = ['body', 'face'];

/**
 * 材質プリセットの id(§2.4.1、11 種)。**未来のプリセットが増えたときの前方互換のため**、
 * ここに無い文字列は `readLiteral` のように断らず、その割り当てだけを落として読み進める
 * (`readAppearanceSpec` 参照)。
 */
const APPEARANCE_PRESET_IDS: readonly AppearancePresetId[] = [
  'default',
  'steel',
  'checkerPlate',
  'expandedMetal',
  'aluminum',
  'stainless',
  'plastic',
  'wood',
  'mirror',
  'glass',
  'custom',
];

/** 柄の種類(FR-1108)。未知の種類は前方互換のため割り当てを落とす(プリセット id と同じ理由)。 */
const APPEARANCE_PATTERN_KINDS: readonly AppearancePattern['kind'][] = [
  'none',
  'expandedMetal',
  'checkerPlate',
  'woodGrain',
];

/** 木材の樹種(§0.a-0.5、6 種)。未知の樹種も同じ理由で割り当てを落とす。 */
const WOOD_SPECIES_VALUES: readonly WoodSpecies[] = [
  'hinoki',
  'sugi',
  'oak',
  'walnut',
  'teak',
  'maple',
];

/** 柄(FR-1108)。繰り返しの間隔は式のまま保存する(FR-202)。 */
function serializeAppearancePattern(pattern: AppearancePattern): AppearancePattern {
  switch (pattern.kind) {
    case 'none':
      return { kind: 'none' };
    case 'expandedMetal':
      return { kind: 'expandedMetal', spacing: serializeExpression(pattern.spacing) };
    case 'checkerPlate':
      return { kind: 'checkerPlate', spacing: serializeExpression(pattern.spacing) };
    case 'woodGrain':
      return {
        kind: 'woodGrain',
        spacing: serializeExpression(pattern.spacing),
        species: pattern.species,
      };
  }
}

/** 見た目そのもの(FR-1107、FR-1109)。透過率・光沢・粗さは式のまま保存する(FR-202)。 */
export function serializeAppearanceSpec(spec: AppearanceSpec): AppearanceSpec {
  return {
    preset: spec.preset,
    color: spec.color,
    transmission: serializeExpression(spec.transmission),
    gloss: serializeExpression(spec.gloss),
    roughness: serializeExpression(spec.roughness),
    pattern: serializeAppearancePattern(spec.pattern),
  };
}

/** 外観の割り当て先(FR-1106)。面は部分形状の参照(P3 の `serializeSubShapeRef` を使い回す)。 */
function serializeAppearanceTarget(target: AppearanceTarget): AppearanceTarget {
  switch (target.kind) {
    case 'body':
      return { kind: 'body', bodyFeatureId: target.bodyFeatureId };
    case 'face':
      return { kind: 'face', ref: serializeSubShapeRef(target.ref) };
  }
}

function serializeAppearanceEntry(entry: AppearanceEntry): AppearanceEntry {
  return {
    id: entry.id,
    target: serializeAppearanceTarget(entry.target),
    appearance: serializeAppearanceSpec(entry.appearance),
  };
}

/** 外観の割り当て表(FR-1106〜1110、版6、P5 タスク5)。 */
export function serializeAppearanceTable(table: AppearanceTable): AppearanceTable {
  return { entries: table.entries.map(serializeAppearanceEntry) };
}

/**
 * 光沢・粗さ・透過率(FR-1107、FR-1109)。0〜100(%)の式を読む。式が壊れて評価値が NaN の
 * ときは `readExpression` が既に許容しているので対象にしないが、有限の数で 0〜100 の範囲外
 * なら壊れたファイルとして断る(統括の指示。範囲外は `invalidField`)。
 */
function readAppearancePercent(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<ExpressionValueJson> {
  const value = readExpression(source, key, parentPath);
  if (!value.ok) {
    return value;
  }
  const path = joinPath(parentPath, key);
  const evaluated = value.value.value;
  if (!Number.isNaN(evaluated) && (evaluated < 0 || evaluated > 100)) {
    return fieldProblem(path, 'type');
  }
  return value;
}

/**
 * 柄(FR-1108)を読む。**未知の柄の種類・未知の樹種は `null` を返し**、呼び出し側
 * (`readAppearanceSpec`)がその割り当てごと落とす(前方互換、タスク5)。
 */
function readAppearancePattern(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<AppearancePattern | null> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readKnownLiteralOrNull(record.value, 'kind', path, APPEARANCE_PATTERN_KINDS);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === null) {
    return { ok: true, value: null };
  }
  switch (kind.value) {
    case 'none':
      return { ok: true, value: { kind: 'none' } };
    case 'expandedMetal': {
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      return { ok: true, value: { kind: 'expandedMetal', spacing: spacing.value } };
    }
    case 'checkerPlate': {
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      return { ok: true, value: { kind: 'checkerPlate', spacing: spacing.value } };
    }
    case 'woodGrain': {
      const spacing = readExpression(record.value, 'spacing', path);
      if (!spacing.ok) {
        return spacing;
      }
      const species = readKnownLiteralOrNull(record.value, 'species', path, WOOD_SPECIES_VALUES);
      if (!species.ok) {
        return species;
      }
      if (species.value === null) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: { kind: 'woodGrain', spacing: spacing.value, species: species.value },
      };
    }
  }
}

/**
 * 見た目そのもの(FR-1107、FR-1109)を読む。**未知のプリセット id・未知の柄・未知の樹種は
 * `null` を返し**、呼び出し側(`readAppearanceEntry`)がその割り当てごと落とす(前方互換)。
 */
export function readAppearanceSpec(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<AppearanceSpec | null> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const preset = readKnownLiteralOrNull(record.value, 'preset', path, APPEARANCE_PRESET_IDS);
  if (!preset.ok) {
    return preset;
  }
  if (preset.value === null) {
    return { ok: true, value: null };
  }
  const color = readString(record.value, 'color', path);
  if (!color.ok) {
    return color;
  }
  const transmission = readAppearancePercent(record.value, 'transmission', path);
  if (!transmission.ok) {
    return transmission;
  }
  const gloss = readAppearancePercent(record.value, 'gloss', path);
  if (!gloss.ok) {
    return gloss;
  }
  const roughness = readAppearancePercent(record.value, 'roughness', path);
  if (!roughness.ok) {
    return roughness;
  }
  const pattern = readAppearancePattern(record.value, 'pattern', path);
  if (!pattern.ok) {
    return pattern;
  }
  if (pattern.value === null) {
    return { ok: true, value: null };
  }
  return {
    ok: true,
    value: {
      preset: preset.value,
      color: color.value,
      transmission: transmission.value,
      gloss: gloss.value,
      roughness: roughness.value,
      pattern: pattern.value,
    },
  };
}

/**
 * 外観の割り当て先(FR-1106)を、値そのもの(record)から読む。面は部分形状の参照
 * (P3 の `readSubShapeRefField` を使い回す)。
 *
 * **選択セットの要素(`SelectionMember`)はここでは読まない。** 利用者の決定(2026-09-06)で
 * 選択セットは辺・頂点も覚えるようになり、型が分かれた(`readSelectionMemberRecord`)。
 * この読み手が辺・頂点も受け付けるようにしてしまうと、外観の欄に `kind: 'edge'` が
 * 書かれたファイルを読めてしまい、「辺に色を塗った」文書が型の上では成立してしまう。
 *
 * 欄から読む口(`readAppearanceTarget`)と値から読む口を分けてあるのは
 * `readCoordinateRecord` / `readCoordinate` と同じ都合で、配列の要素として読むときに
 * 「欄の名前」を場所へ足さないためである。
 */
function readAppearanceTargetRecord(
  record: Record<string, unknown>,
  path: string,
): Checked<AppearanceTarget> {
  const kind = readLiteral(record, 'kind', path, APPEARANCE_TARGET_KINDS);
  if (!kind.ok) {
    return kind;
  }
  switch (kind.value) {
    case 'body': {
      const bodyFeatureId = readString(record, 'bodyFeatureId', path);
      if (!bodyFeatureId.ok) {
        return bodyFeatureId;
      }
      return { ok: true, value: { kind: 'body', bodyFeatureId: bodyFeatureId.value } };
    }
    case 'face': {
      const ref = readSubShapeRefField(record, 'ref', path);
      if (!ref.ok) {
        return ref;
      }
      return { ok: true, value: { kind: 'face', ref: ref.value } };
    }
  }
}

/** 同じものを「親の record の欄」として読む(外観の割り当ての `target`)。 */
function readAppearanceTarget(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<AppearanceTarget> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  return readAppearanceTargetRecord(record.value, joinPath(parentPath, key));
}

/**
 * 外観の割り当て 1 件を読む。**未知のプリセット id・柄の種類・樹種は、この割り当てだけを
 * 落として読み進める**(戻り値 `null`。ファイル全体は断らない。前方互換、計画書タスク5)。
 * それ以外の壊れ方(id・対象・欄の型違い等)は、このファイルの他の読み手と同じく
 * ファイル全体を断る。
 */
function readAppearanceEntry(value: unknown, path: string): Checked<AppearanceEntry | null> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const id = readString(record.value, 'id', path);
  if (!id.ok) {
    return id;
  }
  const target = readAppearanceTarget(record.value, 'target', path);
  if (!target.ok) {
    return target;
  }
  const spec = readAppearanceSpec(record.value, 'appearance', path);
  if (!spec.ok) {
    return spec;
  }
  if (spec.value === null) {
    return { ok: true, value: null };
  }
  return { ok: true, value: { id: id.value, target: target.value, appearance: spec.value } };
}

/**
 * 外観の割り当て表(FR-1106〜1110、要件§4.12)を読む。**版6からは必須**(欠けていれば
 * `missingField`)。版5以前のこの欄が無いファイルは `schema.ts` の `SCHEMA_MIGRATIONS[5]`
 * (欄が無ければ空の表で補う)へ移す。書き手は常にこの欄を書く。
 *
 * id の重複は、表全体を読み終えてから `readEnvelope` がまとめて検査する
 * (`findDuplicateConstraintId` と同じ流儀。1件ずつ読むこの関数では前の割り当てを覚える
 * 状態を持たずに済む)。
 */
export function readAppearanceTable(
  record: Record<string, unknown>,
  path: string,
): Checked<AppearanceTable> {
  const table = readRecord(record, 'appearance', path);
  if (!table.ok) {
    return table;
  }
  const tablePath = joinPath(path, 'appearance');
  const array = readArray(table.value, 'entries', tablePath);
  if (!array.ok) {
    return array;
  }
  const entriesPath = joinPath(tablePath, 'entries');
  const entries: AppearanceEntry[] = [];
  for (let index = 0; index < array.value.length; index += 1) {
    const entry = readAppearanceEntry(array.value[index], indexPath(entriesPath, index));
    if (!entry.ok) {
      return entry;
    }
    if (entry.value !== null) {
      entries.push(entry.value);
    }
  }
  return { ok: true, value: { entries } };
}
