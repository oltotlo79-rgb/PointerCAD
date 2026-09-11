/**
 * 部品文書と `.pcad` の `document.json` の相互変換(計画書 docs/plans/P2-ソリッド基礎.md タスク14、要件§8)。
 *
 * 書き出しは欄を決まった順で組み立てるので、同じ文書からは必ず同じ文字列ができる(決定的)。
 * 保存するのはフィーチャー履歴と式だけで、解決済みの座標・メッシュ(TypedArray)・キャッシュの鍵は
 * 書き出さない(rules/04-設計の規律.md「導出できるものは保存しない」)。
 *
 * 読み込みは `as` による強制変換を使わず、欄を1つずつ検査して型を確かめる(guards.ts)。
 * 決めごとが2つある:
 *  - **知らない欄は捨てる。** 型検査を通ったものだけを取り込む。持ち回ると、保存し直したときに
 *    壊れた組み合わせを書き出してしまうため。
 *  - **読めない欄が1つでもあればファイル全体を断る。** その要素だけを捨てて残りを開くと、
 *    利用者が気づかずに保存し直したときに元のデータを失うため。
 *
 * 版の扱いは統括の決定④(docs/報告記録.md 2026-09-03 07:35)に従う。文書の `schemaVersion` が正で、
 * 封筒の `schema` には同じ値を書く。読み手は封筒の `schema` を先に検査してから中身を読む。
 */

import {
  readAppearanceTable,
  serializeAppearanceTable,
} from './codecs/appearance.js';
import {
  readList,
} from './codecs/fields.js';
import {
  readParameters,
  serializeParameter,
} from './codecs/parameters.js';
import {
  readReferences,
  serializeReferenceFeature,
} from './codecs/referenceGeometry.js';
import {
  readSelectionSets,
  serializeSelectionSet,
} from './codecs/selectionSets.js';
import {
  readSketch,
  serializeSketch,
} from './codecs/sketch.js';
import {
  readCanvases,
  serializeSketchCanvas,
} from './codecs/sketchCanvas.js';
import {
  readSolidFeature,
  serializeSolidFeature,
} from './codecs/solid.js';
import {
  readConfigurationData,
  readNamedViews,
  serializeConfigurations,
  serializeNamedViews,
} from './documentMetadataJson.js';
import {
  type Checked,
  checkRecord,
  fieldProblem,
  type FieldProblem,
  isRecord,
  readLiteral,
  readNumber,
  readRecord,
  readString,
  readValue,
} from './guards.js';
import {
  PCAD_APP_NAME,
  PCAD_DOCUMENT_KIND,
  PCAD_DOCUMENT_KINDS,
  PCAD_SCHEMA_VERSION,
  type PcadDocumentKind,
  type PcadEnvelope,
  type PcadToolDefaults,
  SCHEMA_MIGRATIONS,
} from './schema.js';
import {
  type AppearanceTable,
  LENGTH_UNITS,
  type LengthUnit,
  type PartDocument,
  sketchConstraints,
  type SketchDocument,
} from '@pointercad/model';

import { readSheetUnfolds, serializeSheetUnfold } from './codecs/sheetUnfold.js';

export { serializeExpression } from './codecs/fields.js';
export { serializeRevolveAxis } from './codecs/shapeReferences.js';
export { serializeSubShapeRef } from './codecs/shapeReferences.js';
export { serializeParameter } from './codecs/parameters.js';
export { serializeAppearanceSpec } from './codecs/appearance.js';
export { readList } from './codecs/fields.js';
export { readRevolveAxis } from './codecs/shapeReferences.js';
export { readSubShapeRef } from './codecs/shapeReferences.js';
export { readParameter } from './codecs/parameters.js';
export { readAppearanceSpec } from './codecs/appearance.js';

function serializePartDocument(document: PartDocument): PartDocument {
  return {
    id: document.id,
    name: document.name,
    schemaVersion: document.schemaVersion,
    sketches: document.sketches.map(serializeSketch),
    activeSketchId: document.activeSketchId,
    references: document.references.map(serializeReferenceFeature),
    solids: document.solids.map(serializeSolidFeature),
    sheetUnfolds: document.sheetUnfolds.map(serializeSheetUnfold),
    parameters: document.parameters.map(serializeParameter),
    appearance: serializeAppearanceTable(document.appearance),
    // 版7 で足した 2 欄(P6 §0.a-0.44・0.45)。**外観の後ろに置く**ことで、版6 までの
    // ファイルの並び(id → … → appearance)が 1 行も動かない。
    selectionSets: document.selectionSets.map(serializeSelectionSet),
    canvases: document.canvases.map(serializeSketchCanvas),
    namedViews: serializeNamedViews(document.namedViews),
    configurations: serializeConfigurations(document.configurations),
    activeConfigurationId: document.activeConfigurationId,
  };
}

export interface SerializeOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /**
   * 封筒に書く種別(§0.a-0.35)。既定は部品(`PCAD_DOCUMENT_KIND`)で、
   * ひな形(`.pcadt`)として書き出すときだけ `PCAD_TEMPLATE_KIND` を渡す。
   * 中身(部品文書)の作りは種別で 1 文字も変わらない(履歴を空にするのは上の層の仕事)。
   */
  readonly kind?: PcadDocumentKind;
  /**
   * 表示の長さの単位(FR-814、§2.10)。**ひな形のときだけ渡す。**
   * 渡さなければ封筒にこの欄そのものが出ない(部品の `.pcad` のバイト列は
   * タスク27 の前後で 1 バイトも変わらない)。
   */
  readonly lengthUnit?: LengthUnit;
  /** 各道具の既定値(FR-814、§2.10)。`lengthUnit` と同じく、ひな形のときだけ渡す。 */
  readonly toolDefaults?: PcadToolDefaults;
}

/**
 * 道具の既定値を封筒へ書く形にする(FR-814、§2.10)。
 *
 * 他の `serialize*` と同じく**欄を 1 つずつ決まった順で書き写す**。渡された
 * オブジェクトをそのまま入れないのは、①欄の順が呼び出し側の作り方に左右されると
 * 同じ中身から同じバイト列ができなくなる(`pcadFile.ts` 冒頭の約束)、
 * ②知らない欄が紛れ込んでも保存されない、の 2 つによる。
 */
function serializeToolDefaults(toolDefaults: PcadToolDefaults): PcadToolDefaults {
  return {
    extrudeDistance: toolDefaults.extrudeDistance,
    holeDiameter: toolDefaults.holeDiameter,
    filletRadius: toolDefaults.filletRadius,
    chamferDistance: toolDefaults.chamferDistance,
    circleRadius: toolDefaults.circleRadius,
  };
}

/**
 * 部品文書を `.pcad` の `document.json` の中身へ書き出す(UTF-8、インデント 2、末尾に改行 1 つ)。
 * 同じ文書からは必ず同じ文字列ができる(欄を決まった順で組み立てるため)。
 */
export function serializeDocument(document: PartDocument, options: SerializeOptions = {}): string {
  const envelope: PcadEnvelope = {
    // 封筒の版は文書の版と同じ値を書く(統括の決定④)。
    schema: document.schemaVersion,
    // 既定は部品(要件§8)。ひな形のときだけ呼び出し側が種別を渡す(§0.a-0.35)。
    kind: options.kind ?? PCAD_DOCUMENT_KIND,
    app: PCAD_APP_NAME,
    savedAt: options.savedAt ?? new Date().toISOString(),
    /*
      ひな形の 2 欄(FR-814、§2.10)。**渡されなければ `undefined` のままにする。**
      `JSON.stringify` は値が `undefined` の欄を書かないので、部品の `.pcad` の
      バイト列はタスク27 の前後で 1 バイトも変わらない(既存の検査がそれを固定している)。
      場所を `savedAt` と `document` の間にしてあるのは、封筒の欄(小さい設定)を
      先に、中身(大きい文書)を最後に置く並びを崩さないためである。
    */
    lengthUnit: options.lengthUnit,
    toolDefaults:
      options.toolDefaults === undefined ? undefined : serializeToolDefaults(options.toolDefaults),
    document: serializePartDocument(document),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function readPartDocument(value: unknown, path: string): Checked<PartDocument> {
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
  const schemaVersion = readNumber(record.value, 'schemaVersion', path);
  if (!schemaVersion.ok) {
    return schemaVersion;
  }
  const sketches = readList(record.value, 'sketches', path, readSketch);
  if (!sketches.ok) {
    return sketches;
  }
  const activeSketchId = readString(record.value, 'activeSketchId', path);
  if (!activeSketchId.ok) {
    return activeSketchId;
  }
  const references = readReferences(record.value, path);
  if (!references.ok) {
    return references;
  }
  const solids = readList(record.value, 'solids', path, readSolidFeature);
  if (!solids.ok) {
    return solids;
  }
  const parameters = readParameters(record.value, path);
  if (!parameters.ok) {
    return parameters;
  }
  const appearance = readAppearanceTable(record.value, path);
  if (!appearance.ok) {
    return appearance;
  }
  const selectionSets = readSelectionSets(record.value, path);
  if (!selectionSets.ok) {
    return selectionSets;
  }
  const canvases = readCanvases(record.value, path);
  if (!canvases.ok) {
    return canvases;
  }
  const namedViews = readNamedViews(record.value, path);
  if (!namedViews.ok) return namedViews;
  const configurations = readConfigurationData(record.value, path, parameters.value);
  if (!configurations.ok) return configurations;
  const sheetUnfolds = readSheetUnfolds(record.value, path);
  if (!sheetUnfolds.ok) return sheetUnfolds;
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      schemaVersion: schemaVersion.value,
      sketches: sketches.value,
      activeSketchId: activeSketchId.value,
      references: references.value,
      solids: solids.value,
      sheetUnfolds: sheetUnfolds.value,
      parameters: parameters.value,
      appearance: appearance.value,
      selectionSets: selectionSets.value,
      canvases: canvases.value,
      namedViews: namedViews.value,
      ...configurations.value,
    },
  };
}

// ---------------------------------------------------------------------------
// 読み込みの入口と断り方(FR-504、NFR-UX-5)
// ---------------------------------------------------------------------------

export type ParseErrorCode =
  /** JSON として読めない。 */
  | 'invalidJson'
  /** PointerCAD の部品ファイルの封筒になっていない。 */
  | 'notPcad'
  /** PointerCAD のファイルではあるが、部品ではない種別(アセンブリ・図面)。 */
  | 'unsupportedKind'
  /** 版が古すぎて、今の版まで持ち上げる手立てが無い。 */
  | 'unsupportedOldVersion'
  /** 版が新しすぎる(このアプリより後の版で保存された)。 */
  | 'unsupportedNewVersion'
  /** 封筒の版と文書の版が食い違う。 */
  | 'versionMismatch'
  /** 必要な欄が無い。 */
  | 'missingField'
  /** 欄はあるが型が違う。 */
  | 'invalidField';

/** 読み込めなかった理由。`message` はそのまま利用者へ見せる日本語(NFR-UX-5)。 */
export interface ParseError {
  readonly code: ParseErrorCode;
  readonly message: string;
}

export type ParseDocumentResult =
  | {
      readonly ok: true;
      readonly document: PartDocument;
      readonly savedAt: string;
      /**
       * 封筒に書かれていた種別(§0.a-0.35)。部品なら `'part'`、ひな形なら `'partTemplate'`。
       * **中身の読み方は種別で変わらない**ので、ここで返して上の層(タスク27 の
       * 「このファイルはひな形ではありません。」の断り)に判断させる。
       */
      readonly kind: PcadDocumentKind;
      /**
       * 封筒に書かれていた表示の長さの単位(FR-814、§2.10)。**欄が無ければ `undefined`**
       * ——ここではファイルに書いてあったとおりを返し、既定(`'mm'`)で埋めるのは上の層
       * (model の `openTemplate`)の仕事にする。既定値を io と model の両方に置かないため。
       */
      readonly lengthUnit?: LengthUnit;
      /** 封筒に書かれていた道具の既定値(FR-814)。`lengthUnit` と同じく、無ければ `undefined`。 */
      readonly toolDefaults?: PcadToolDefaults;
    }
  | { readonly ok: false; readonly error: ParseError };

const NOT_PCAD_MESSAGE = 'PointerCAD の部品ファイルではないようです。';

function fail(code: ParseErrorCode, message: string): ParseDocumentResult {
  return { ok: false, error: { code, message } };
}

/** 欄の不備を、場所を添えた日本語にする。 */
function failField(problem: FieldProblem): ParseDocumentResult {
  return problem.reason === 'missing'
    ? fail('missingField', `ファイルの中身が壊れています(${problem.path} が見つかりません)。`)
    : fail('invalidField', `ファイルの中身が壊れています(${problem.path} の形が違います)。`);
}

function parseJsonText(text: string): Checked<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return fieldProblem('', 'type');
  }
}

/**
 * 古い版を今の版まで順に持ち上げる(要件§8 の前方互換)。持ち上げられなければ null。
 * P2 では `SCHEMA_MIGRATIONS` が空なので、版 1 はここで必ず null になる。
 */
export function migrateToCurrentSchema(
  raw: Record<string, unknown>,
  schema: number,
): Record<string, unknown> | null {
  let current = raw;
  let version = schema;
  while (version < PCAD_SCHEMA_VERSION) {
    const migration = SCHEMA_MIGRATIONS[version];
    if (migration === undefined) {
      return null;
    }
    const lifted = migration(current);
    if (!isRecord(lifted)) {
      return null;
    }
    const next = readNumber(lifted, 'schema', '');
    // 版が上がらない変換は同じ段を回り続けるので、変換表の誤りとして断る。
    if (!next.ok || next.value <= version) {
      return null;
    }
    current = lifted;
    version = next.value;
  }
  return version === PCAD_SCHEMA_VERSION ? current : null;
}

/**
 * 封筒の任意の欄「表示の長さの単位」を読む(FR-814、§2.10。P6 タスク27)。
 *
 * **欄が無いのは不備ではない**(版 7 でも持たないファイルがある)ので `undefined` を返す。
 * 欄があるのに知らない値だったときだけ、他の欄と同じ厳しさで断る(`invalidField`)。
 */
function readEnvelopeLengthUnit(raw: Record<string, unknown>): Checked<LengthUnit | undefined> {
  if (!('lengthUnit' in raw)) {
    return { ok: true, value: undefined };
  }
  return readLiteral<LengthUnit>(raw, 'lengthUnit', '', LENGTH_UNITS);
}

/**
 * 封筒の任意の欄「道具の既定値」を読む(FR-814、§2.10)。`lengthUnit` と同じく、
 * **欄が無ければ `undefined`、あれば 5 欄すべてを厳密に検査する。**
 *
 * 途中まで書かれた `toolDefaults` を「ある分だけ読む」ようにはしない。半端な設定を
 * 黙って受け入れると、どの値が利用者の指定でどれが既定なのかが後から分からなくなる。
 * 知らない欄は読み飛ばす(P12 で欄が増えたひな形を、この版のアプリでも開けるように)。
 */
function readEnvelopeToolDefaults(
  raw: Record<string, unknown>,
): Checked<PcadToolDefaults | undefined> {
  if (!('toolDefaults' in raw)) {
    return { ok: true, value: undefined };
  }
  const record = readRecord(raw, 'toolDefaults', '');
  if (!record.ok) {
    return record;
  }
  const path = 'toolDefaults';
  const extrudeDistance = readString(record.value, 'extrudeDistance', path);
  if (!extrudeDistance.ok) {
    return extrudeDistance;
  }
  const holeDiameter = readString(record.value, 'holeDiameter', path);
  if (!holeDiameter.ok) {
    return holeDiameter;
  }
  const filletRadius = readString(record.value, 'filletRadius', path);
  if (!filletRadius.ok) {
    return filletRadius;
  }
  const chamferDistance = readString(record.value, 'chamferDistance', path);
  if (!chamferDistance.ok) {
    return chamferDistance;
  }
  const circleRadius = readString(record.value, 'circleRadius', path);
  if (!circleRadius.ok) {
    return circleRadius;
  }
  return {
    ok: true,
    value: {
      extrudeDistance: extrudeDistance.value,
      holeDiameter: holeDiameter.value,
      filletRadius: filletRadius.value,
      chamferDistance: chamferDistance.value,
      circleRadius: circleRadius.value,
    },
  };
}

/** 版の判定が済んだ封筒を読む。 */
function readEnvelope(raw: Record<string, unknown>, schema: number): ParseDocumentResult {
  const app = readString(raw, 'app', '');
  if (!app.ok || app.value !== PCAD_APP_NAME) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  // 種別は封筒の欄なので、中身を読む前に見る(統括の決定、要件§8)。
  // 欄そのものが無い・文字列でないものは PointerCAD の封筒になっていないので notPcad、
  // 文字列だが受け入れる一覧(部品とひな形。§0.a-0.35)に無いものは
  // 「PointerCAD のファイルだが、この種類はまだ読めない」と分けて断る。
  const kind = readString(raw, 'kind', '');
  if (!kind.ok) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  if (!isPcadDocumentKind(kind.value)) {
    return fail(
      'unsupportedKind',
      `この形式の種類(${kind.value})にはまだ対応していません。`,
    );
  }
  const savedAt = readString(raw, 'savedAt', '');
  if (!savedAt.ok) {
    return failField(savedAt.problem);
  }
  // ひな形の 2 欄(FR-814、§2.10)。どちらも任意なので、無いこと自体は断りにならない。
  const lengthUnit = readEnvelopeLengthUnit(raw);
  if (!lengthUnit.ok) {
    return failField(lengthUnit.problem);
  }
  const toolDefaults = readEnvelopeToolDefaults(raw);
  if (!toolDefaults.ok) {
    return failField(toolDefaults.problem);
  }
  const document = readValue(raw, 'document', '');
  if (!document.ok) {
    return failField(document.problem);
  }
  const decoded = readPartDocument(document.value, 'document');
  if (!decoded.ok) {
    return failField(decoded.problem);
  }
  if (decoded.value.schemaVersion !== schema) {
    return fail(
      'versionMismatch',
      `ファイルの版の記録が食い違っています(封筒 ${String(schema)} / 文書 ${String(decoded.value.schemaVersion)})。`,
    );
  }
  const duplicateConstraintId = findDuplicateConstraintId(decoded.value.sketches);
  if (duplicateConstraintId !== null) {
    return fail(
      'invalidField',
      `拘束の id が文書の中で重なっています(${duplicateConstraintId})。ファイルが壊れている可能性があります。`,
    );
  }
  const duplicateAppearanceId = findDuplicateAppearanceId(decoded.value.appearance);
  if (duplicateAppearanceId !== null) {
    return fail(
      'invalidField',
      `外観の割り当ての id が重なっています(${duplicateAppearanceId})。ファイルが壊れている可能性があります。`,
    );
  }
  const duplicateSelectionSetId = findDuplicateId(
    decoded.value.selectionSets.map((set) => set.id),
  );
  if (duplicateSelectionSetId !== null) {
    return fail(
      'invalidField',
      `選択セットの id が重なっています(${duplicateSelectionSetId})。ファイルが壊れている可能性があります。`,
    );
  }
  const duplicateCanvasId = findDuplicateId(decoded.value.canvases.map((canvas) => canvas.id));
  if (duplicateCanvasId !== null) {
    return fail(
      'invalidField',
      `下絵の id が重なっています(${duplicateCanvasId})。ファイルが壊れている可能性があります。`,
    );
  }
  return {
    ok: true,
    document: decoded.value,
    savedAt: savedAt.value,
    kind: kind.value,
    lengthUnit: lengthUnit.value,
    toolDefaults: toolDefaults.value,
  };
}

/**
 * 封筒の `kind` が受け入れる種別のどれかかを確かめる(§0.a-0.35)。
 * `Array.includes` は引数の型を一覧の型に狭めてしまい `as` が要るので、
 * 自前の型ガードで書く(**`as` / `any` を使わない**)。
 */
function isPcadDocumentKind(value: string): value is PcadDocumentKind {
  for (const candidate of PCAD_DOCUMENT_KINDS) {
    if (candidate === value) {
      return true;
    }
  }
  return false;
}

/**
 * 拘束の `id` は文書の中(複数スケッチをまたいで)重ならないことを確かめる(P4b タスク21の
 * 落とし穴)。重なると一覧と印が混ざるため、見つけたら理由つきで断る。
 */
function findDuplicateConstraintId(sketches: readonly SketchDocument[]): string | null {
  const seen = new Set<string>();
  for (const sketch of sketches) {
    for (const constraint of sketchConstraints(sketch)) {
      if (seen.has(constraint.id)) {
        return constraint.id;
      }
      seen.add(constraint.id);
    }
  }
  return null;
}

/**
 * 外観の割り当ての `id` は表の中で重ならないことを確かめる(FR-1106〜1110、P5 タスク5)。
 * `findDuplicateConstraintId` と同じ理由(重なると「1 つずつ外す」(FR-1110)がどちらを
 * 外すか決まらない。統括の指示により、重複は前方互換の対象にせず `invalidField` で断る)。
 */
function findDuplicateAppearanceId(table: AppearanceTable): string | null {
  const seen = new Set<string>();
  for (const entry of table.entries) {
    if (seen.has(entry.id)) {
      return entry.id;
    }
    seen.add(entry.id);
  }
  return null;
}

/**
 * 選択セット・下絵の `id` が重なっていないことを確かめる(FR-112、FR-332、P6 タスク37・38)。
 * `findDuplicateAppearanceId` とまったく同じ理由(重なると「1 つずつ消す」「名前を変える」が
 * どちらを指すか決まらない)で、**エラーコードは増やさず** `invalidField` で断る。
 */
function findDuplicateId(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      return id;
    }
    seen.add(id);
  }
  return null;
}

/**
 * 移行を試みる前に、封筒の版と文書自身が持つ版が食い違っていないかを確かめる
 * (要件§8、統括の決定④)。移行は封筒の版だけで判定し(このファイル冒頭の決めごと)、
 * `SCHEMA_MIGRATIONS` の各段は `schemaVersion` を無条件に書き換えるため、
 * ここで先に確かめないと版4への移行(P4 タスク31)が移行前の食い違いを握りつぶしてしまう
 * (`readEnvelope` の同種の検査は移行の要らない=封筒が今の版のときにしか通らない)。
 * `document` が record でない、または `schemaVersion` が数でなければ、
 * その不備は通常の欄検査(`readPartDocument`)に断らせるのでここでは何もしない。
 */
function envelopeDocumentVersionMismatch(
  raw: Record<string, unknown>,
  schema: number,
): ParseDocumentResult | null {
  const document = raw['document'];
  if (!isRecord(document)) {
    return null;
  }
  const declared = document['schemaVersion'];
  if (typeof declared !== 'number' || declared === schema) {
    return null;
  }
  return fail(
    'versionMismatch',
    `ファイルの版の記録が食い違っています(封筒 ${String(schema)} / 文書 ${String(declared)})。`,
  );
}

/**
 * `document.json` の中身(すでに JSON.parse 済みのもの)から部品文書を読む。
 * 封筒の `schema` を先に検査してから中身を読む(統括の決定④)。
 */
function decodeFile(raw: unknown): ParseDocumentResult {
  if (!isRecord(raw)) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  const schema = readNumber(raw, 'schema', '');
  if (!schema.ok) {
    return fail('notPcad', NOT_PCAD_MESSAGE);
  }
  if (schema.value > PCAD_SCHEMA_VERSION) {
    return fail(
      'unsupportedNewVersion',
      `このファイルは新しい版の PointerCAD で保存されています(版 ${String(schema.value)})。アプリを更新してください。`,
    );
  }
  if (schema.value < PCAD_SCHEMA_VERSION) {
    // 移行先(`SCHEMA_MIGRATIONS[schema.value]`)が無い版(例: 版1)は、この時点では
    // まだ移行を試みないので、文書側の版と比べても意味が無い(必ず unsupportedOldVersion
    // になるべきところを versionMismatch にすり替えない)。移行が実在する版だけ検査する。
    if (SCHEMA_MIGRATIONS[schema.value] !== undefined) {
      const mismatch = envelopeDocumentVersionMismatch(raw, schema.value);
      if (mismatch !== null) {
        return mismatch;
      }
    }
    const lifted = migrateToCurrentSchema(raw, schema.value);
    if (lifted === null) {
      return fail('unsupportedOldVersion', `対応していない古い版です(版 ${String(schema.value)})。`);
    }
    return readEnvelope(lifted, PCAD_SCHEMA_VERSION);
  }
  return readEnvelope(raw, schema.value);
}

/**
 * `.pcad` の `document.json` の中身から部品文書を読む。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
export function parseDocument(text: string): ParseDocumentResult {
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return fail(
      'invalidJson',
      'ファイルの中身を読み取れませんでした。PointerCAD のファイルか確かめてください。',
    );
  }
  return decodeFile(parsed.value);
}
