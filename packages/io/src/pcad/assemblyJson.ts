import { readComponentSource } from './codecs/componentSource.js';
import { readJointOccurrenceConnections, serializeJointOccurrenceConnections } from './codecs/jointOccurrenceConnections.js';
import { readBoltedJointRecords, serializeBoltedJointRecords } from './codecs/boltedJointRecords.js';
/**
 * アセンブリ文書と `.pcada` の `document.json` の相互変換
 * (計画書 docs/plans/P7-アセンブリ.md タスク3、§2.2、要件§8、FR-801)。
 *
 * **書き方は部品の `documentJson.ts` とまったく同じにする。**
 *  - 書き出しは欄を決まった順で組み立てるので、同じ文書からは必ず同じ文字列ができる(決定的)。
 *  - 読み込みは `as` を使わず、欄を 1 つずつ検査して型を確かめる(`guards.ts`)。
 *  - **知らない欄は捨てる。読めない欄が 1 つでもあればファイル全体を断る。**
 *  - 断りのコードは部品と同じ `ParseErrorCode` を使い回す(**エラーコードを増やさない**。
 *    `docs/報告記録.md` 2026-09-04 01:40 の③)。
 *
 * 部品と共通の値(式・パラメータ・部分形状の参照・軸・外観)の変換は `documentJson.ts` から
 * 輸入する(**同じ書式を 2 か所に書かない**)。種類の一覧(`MATE_KINDS`・`JOINT_KINDS`・
 * `STANDARD_CATALOG_IDS`・`BOM_COLUMN_IDS`・`BOM_SORT_KEYS`)は model 側を正本にして
 * `readLiteral` へ渡し、知らない種類は「その欄の型が違う」として断る。
 *
 * **保存しないもの**(`rules/04-設計の規律.md`「導出できるものは保存しない」):
 * 部品の形(B-rep・三角形)、合致の解、いまの再生位置、部品表の集計。いずれも
 * 開いてから作り直す(§0.a-0.4、§0.a-0.6)。抱き込んだ部品文書そのものは
 * `document.json` ではなく ZIP の別エントリ(`parts/<ref>.json`、`pcadFile.ts`)に入る。
 */

import { readOptionalBeamAnalysisInputs, serializeBeamAnalysisInputs } from './codecs/beamAnalysis.js';
import { readNamedViews, serializeNamedViews } from './documentMetadataJson.js';
import { assertReferenceOriginVersion } from './referenceOriginVersion.js';
import {
  BOM_COLUMN_IDS,
  BOM_SORT_KEYS,
  JOINT_KINDS,
  MECHANISM_COUPLING_KINDS,
  CROSS_LEVEL_GEAR_KINDS,
  CROSS_LEVEL_CAM_KINDS,
  camDimensionFailure,
  crossLevelGearDocumentFailure,
  crossLevelCamDocumentFailure,
  contextReferencesHaveCycle,
  evaluateCamCouplings,
  evaluateMechanismCouplings,
  mechanismCouplingLoopFailure,
  MATE_KINDS,
  type AppearanceSpec,
  type AssemblyComponent,
  type AssemblyDocument,
  type AxisSpec,
  type BomColumnId,
  type BomSettings,
  type BomSortKey,
  type ComponentSource,
  type ContextReferenceLink,
  type CrossLevelGearCouplingDefinition,
  type CrossLevelCamCouplingDefinition,
  type Joint,
  type JointOccurrenceConnection,
  type MechanismCamCoupling,
  type MechanismGearCoupling,
  type Mate,
  type MateTarget,
  type OriginElement,
  type Parameter,
  type Placement,
  type PresentationStep,
} from '@pointercad/model';

import {
  migrateToCurrentSchema,
  readAppearanceSpec,
  readList,
  readParameter,
  readRevolveAxis,
  readSubShapeRef,
  serializeAppearanceSpec,
  serializeExpression,
  serializeParameter,
  serializeRevolveAxis,
  serializeSubShapeRef,
  type ParseError,
  type ParseErrorCode,
} from './documentJson.js';
import {
  checkRecord,
  fieldProblem,
  indexPath,
  isRecord,
  isUnknownArray,
  joinPath,
  readArray,
  readBoolean,
  readExpression,
  readExpressionItem,
  readLiteral,
  readNumber,
  readRecord,
  readString,
  readValue,
  type Checked,
  type ExpressionValueJson,
  type FieldProblem,
} from './guards.js';
import {
  PCAD_APP_NAME,
  PCAD_ASSEMBLY_KIND,
  PCAD_ASSEMBLY_KINDS,
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  type PcadAssemblyEnvelope,
  type PcadAssemblyKind,
  type PcadPartFile,
} from './schema.js';

/**
 * 判別に使う文字列の一覧。`as` を使わずに型から取り出す(`documentJson.ts` と同じ流儀)。
 * model 側に定数の一覧があるもの(合致・ジョイント・規格部品・部品表)はそちらを正本にし、
 * ここには**型にしか無いもの**だけを並べる。
 */
const MATE_TARGET_KINDS: readonly MateTarget['kind'][] = ['subShape', 'origin'];
/**
 * 部品の基準ジオメトリのうち合致に取れるもの(原点・3 軸・3 平面。FR-329)。
 * 綴りは model の `OriginElement` と同じで、面の名前は基準の 3 面(`BaseWorkPlaneId`)に揃う。
 */
const ORIGIN_ELEMENTS: readonly OriginElement[] = ['origin', 'x', 'y', 'z', 'xy', 'xz', 'yz'];
/** 分解・アニメーションのステップの中身 2 種(FR-617、FR-618)。 */
const PRESENTATION_BODY_KINDS: readonly PresentationStep['body']['kind'][] = ['explode', 'joint'];

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/**
 * 規格部品の追加の指定(§0.a-0.34)を**鍵の順に並べ直す**。
 *
 * 表の並び順は作った側の都合で変わるので、**同じ中身から同じバイト列**ができる約束
 * (`pcadFile.ts` 冒頭)を守るために毎回そろえる(添付の `sortedEntries` と同じ理由)。
 */
function serializeStandardOptions(
  options: Readonly<Record<string, string>>,
): Record<string, string> {
  const pairs = Object.entries(options).sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  const sorted: Record<string, string> = {};
  for (const [key, value] of pairs) {
    sorted[key] = value;
  }
  return sorted;
}

/** 部品の出どころ(§0.a-0.3)。種類ごとに欄が違うので `kind` で分岐する。 */
function serializeComponentSource(source: ComponentSource): ComponentSource {
  switch (source.kind) {
    case 'part':
      return { kind: 'part', partRef: source.partRef };
    case 'subAssembly':
      return { kind: 'subAssembly', assemblyRef: source.assemblyRef };
    case 'standardPart':
      // 呼び寸法だけを保存し、組み立てた部品文書は保存しない(§0.a-0.35)。
      return {
        kind: 'standardPart',
        catalog: source.catalog,
        size: source.size,
        options: serializeStandardOptions(source.options),
        catalogRevision: source.catalogRevision,
        generatorRevision: source.generatorRevision,
      };
  }
}

/**
 * 配置(§2.4)。位置は式のまま、向きは四元数の 4 数をそのまま書く。
 * **`w >= 0` へ揃えるのは model の `normalizePlacement` の仕事**(§0.a-0.54)で、
 * ここでは受け取った値を写すだけにする(同じ正規化を 2 か所に置かない)。
 */
function serializePlacement(placement: Placement): Placement {
  return {
    position: [
      serializeExpression(placement.position[0]),
      serializeExpression(placement.position[1]),
      serializeExpression(placement.position[2]),
    ],
    rotation: [
      placement.rotation[0],
      placement.rotation[1],
      placement.rotation[2],
      placement.rotation[3],
    ],
  };
}

/** 合致・ジョイントの対象(§0.a-0.14)。部分形状は P3 の指紋つきの参照をそのまま使う。 */
function serializeMateTarget(target: MateTarget): MateTarget {
  switch (target.kind) {
    case 'subShape':
      return {
        kind: 'subShape',
        componentId: target.componentId,
        ref: serializeSubShapeRef(target.ref),
      };
    case 'origin':
      return { kind: 'origin', componentId: target.componentId, element: target.element };
  }
}

/**
 * 置いた部品 1 つ(FR-606)。**外観と材質は省略できる欄**なので、無ければ欄ごと書かない
 * (押し出しの `end`・穴の `entry` と同じ流儀。持たない状態と「空の指定」を混ぜない)。
 */
function serializeComponent(component: AssemblyComponent): AssemblyComponent {
  return {
    id: component.id,
    name: component.name,
    source: serializeComponentSource(component.source),
    placement: serializePlacement(component.placement),
    fixed: component.fixed,
    visible: component.visible,
    suppressed: component.suppressed,
    ...(component.appearance === undefined
      ? {}
      : { appearance: serializeAppearanceSpec(component.appearance) }),
    ...(component.materialId === undefined ? {} : { materialId: component.materialId }),
    // 互いに固定した組(ボルト締結)。属さない部品は欄ごと書かない(旧い文書と同じ形)。
    ...(component.rigidGroupId === undefined || component.rigidGroupId === ''
      ? {} : { rigidGroupId: component.rigidGroupId }),
  };
}

/**
 * 合致 1 本(FR-603、FR-609)。距離・角度は種類によって使わないので、
 * **持たないものは欄ごと書かない**(`AssemblyComponent.appearance` と同じ扱い)。
 */
function serializeMate(mate: Mate): Mate {
  return {
    id: mate.id,
    name: mate.name,
    kind: mate.kind,
    a: serializeMateTarget(mate.a),
    b: serializeMateTarget(mate.b),
    ...(mate.value === undefined ? {} : { value: serializeExpression(mate.value) }),
    flipped: mate.flipped,
    suppressed: mate.suppressed,
  };
}

/**
 * ジョイント 1 つ(FR-618)。可動範囲は**無制限を `null` として必ず書く**
 * (欄ごと省略しない。「まだ決めていない」と「無制限」を読む側が分けずに済む)。
 */
function serializeMechanismCoupling(coupling: MechanismGearCoupling): MechanismGearCoupling {
  return { id: coupling.id, kind: coupling.kind, jointAId: coupling.jointAId,
    jointBId: coupling.jointBId, ratio: serializeExpression(coupling.ratio),
    phaseDeg: serializeExpression(coupling.phaseDeg), referenceAngleA: coupling.referenceAngleA,
    suppressed: coupling.suppressed };
}

/** Cam-follower relation: authored expressions and the reference angle only, never solved poses. */
function serializeCamCoupling(coupling: MechanismCamCoupling): MechanismCamCoupling {
  return { id: coupling.id, kind: coupling.kind, camJointId: coupling.camJointId,
    followerJointId: coupling.followerJointId, discRadiusMm: serializeExpression(coupling.discRadiusMm),
    eccentricityMm: serializeExpression(coupling.eccentricityMm),
    rollerRadiusMm: serializeExpression(coupling.rollerRadiusMm), phaseDeg: serializeExpression(coupling.phaseDeg),
    referenceAngleCam: coupling.referenceAngleCam, suppressed: coupling.suppressed };
}

/** Cross-level gear: authored expressions, ids and the typed occurrence path only, never solved angles. */
function serializeCrossLevelGearCoupling(coupling: CrossLevelGearCouplingDefinition): CrossLevelGearCouplingDefinition {
  return { id: coupling.id, kind: coupling.kind, parentJointId: coupling.parentJointId, childPath: [...coupling.childPath],
    childJointId: coupling.childJointId, ratio: serializeExpression(coupling.ratio),
    phaseDeg: serializeExpression(coupling.phaseDeg), suppressed: coupling.suppressed };
}

/** Cross-level cam: authored expressions, the direction, ids and the typed occurrence path only, never solved poses. */
function serializeCrossLevelCamCoupling(coupling: CrossLevelCamCouplingDefinition): CrossLevelCamCouplingDefinition {
  return { id: coupling.id, kind: coupling.kind, camJointId: coupling.camJointId, childPath: [...coupling.childPath],
    childJointId: coupling.childJointId, discRadiusMm: serializeExpression(coupling.discRadiusMm),
    eccentricityMm: serializeExpression(coupling.eccentricityMm), rollerRadiusMm: serializeExpression(coupling.rollerRadiusMm),
    phaseDeg: serializeExpression(coupling.phaseDeg), offsetMm: serializeExpression(coupling.offsetMm),
    direction: coupling.direction, suppressed: coupling.suppressed };
}

function serializeContextReference(link: ContextReferenceLink): ContextReferenceLink {
  return { id: link.id, targetComponentId: link.targetComponentId, targetReferenceId: link.targetReferenceId,
    sourceComponentId: link.sourceComponentId, source: serializeSubShapeRef(link.source) };
}

function serializeJoint(joint: Joint): Joint {
  return {
    id: joint.id,
    name: joint.name,
    kind: joint.kind,
    a: serializeMateTarget(joint.a),
    b: serializeMateTarget(joint.b),
    minValue: joint.minValue === null ? null : serializeExpression(joint.minValue),
    maxValue: joint.maxValue === null ? null : serializeExpression(joint.maxValue),
    suppressed: joint.suppressed,
  };
}

/** 分解・アニメーションのステップ 1 つ(FR-617、FR-618)。中身は `kind` で分岐する。 */
function serializePresentationStep(step: PresentationStep): PresentationStep {
  return {
    id: step.id,
    name: step.name,
    start: step.start,
    end: step.end,
    body:
      step.body.kind === 'explode'
        ? {
            kind: 'explode',
            componentIds: [...step.body.componentIds],
            // 向きは P5 の `AxisSpec`(= `RevolveAxis`)を流用する(§0.a-0.36)。
            direction: serializeRevolveAxis(step.body.direction),
            distance: serializeExpression(step.body.distance),
          }
        : {
            kind: 'joint',
            jointId: step.body.jointId,
            from: serializeExpression(step.body.from),
            to: serializeExpression(step.body.to),
            ...(step.body.coordinate === undefined ? {} : { coordinate: step.body.coordinate }),
            ...(step.body.referenceAngle === undefined
              ? {}
              : { referenceAngle: step.body.referenceAngle }),
          },
  };
}

/** 部品表の見せ方(FR-611)。集計そのものは保存しない(毎回数え直す。§2.10)。 */
function serializeBomSettings(bom: BomSettings): BomSettings {
  return {
    columns: [...bom.columns],
    sortBy: bom.sortBy,
    expandSubAssemblies: bom.expandSubAssemblies,
  };
}

/** アセンブリ文書を決まった順で組み立てる。 */
function serializeAssemblyDocumentBody(document: AssemblyDocument): AssemblyDocument {
  if (document.jointOccurrenceConnections !== undefined && document.schemaVersion < 21) {
    throw new RangeError('Persisted joint occurrence provenance requires document schema 21');
  }
  if (document.beamAnalysisInputs !== undefined && document.schemaVersion < 20) {
    throw new RangeError('Persisted beam inputs require document schema 20');
  }
  return {
    ...(document.beamAnalysisInputs === undefined ? {} : {
      beamAnalysisInputs: serializeBeamAnalysisInputs(document.beamAnalysisInputs, document.id, 'assembly'),
    }),
    id: document.id,
    name: document.name,
    schemaVersion: document.schemaVersion,
    ...(document.jointOccurrenceConnections === undefined ? {} : {
      jointOccurrenceConnections: serializeJointOccurrenceConnections(document.jointOccurrenceConnections, document.components),
    }),
    // Bolted-joint edit records (EX-06). Omitted when empty so files without them keep their exact bytes.
    ...(document.boltedJoints === undefined || document.boltedJoints.length === 0 ? {} : {
      boltedJoints: serializeBoltedJointRecords(document.boltedJoints, document.components),
    }),
    components: document.components.map(serializeComponent),
    mates: document.mates.map(serializeMate),
    joints: document.joints.map(serializeJoint),
    ...(document.mechanismCouplings === undefined ? {} : {
      mechanismCouplings: document.mechanismCouplings.map(serializeMechanismCoupling),
    }),
    ...(document.camCouplings === undefined ? {} : {
      camCouplings: document.camCouplings.map(serializeCamCoupling),
    }),
    ...(document.crossLevelGearCouplings === undefined ? {} : {
      crossLevelGearCouplings: document.crossLevelGearCouplings.map(serializeCrossLevelGearCoupling),
    }),
    ...(document.crossLevelCamCouplings === undefined ? {} : {
      crossLevelCamCouplings: document.crossLevelCamCouplings.map(serializeCrossLevelCamCoupling),
    }),
    ...(document.contextReferences === undefined ? {} : {
      contextReferences: document.contextReferences.map(serializeContextReference),
    }),
    presentation: document.presentation.map(serializePresentationStep),
    parameters: document.parameters.map(serializeParameter),
    bom: serializeBomSettings(document.bom),
    namedViews: serializeNamedViews(document.namedViews),
  };
}

/** 抱き込んだ部品 1 つの素性(要件§8)。欄を 1 つずつ決まった順で書き写す。 */
function serializePartFile(partFile: PcadPartFile): PcadPartFile {
  return {
    ref: partFile.ref,
    fileName: partFile.fileName,
    path: partFile.path,
    contentHash: partFile.contentHash,
    importedAt: partFile.importedAt,
  };
}

export interface WriteAssemblyDocumentOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /**
   * 抱き込んだ部品の素性(要件§8、§2.3)。**文書そのものは ZIP の別エントリ**なので、
   * ここへ渡すのは「どのファイルから取り込んだか」だけ。渡さなければ空の一覧を書く。
   */
  readonly partFiles?: readonly PcadPartFile[];
}

/**
 * アセンブリ文書を `.pcada` の `document.json` の中身へ書き出す
 * (UTF-8、インデント 2、末尾に改行 1 つ)。同じ文書からは必ず同じ文字列ができる。
 */
export function writeAssemblyDocument(
  document: AssemblyDocument,
  options: WriteAssemblyDocumentOptions = {},
): string {
  assertReferenceOriginVersion(document, document.schemaVersion);
  const envelope: PcadAssemblyEnvelope = {
    // 封筒の版は文書の版と同じ値を書く(部品と同じ決めごと。統括の決定④)。
    schema: document.schemaVersion,
    kind: PCAD_ASSEMBLY_KIND,
    app: PCAD_APP_NAME,
    savedAt: options.savedAt ?? new Date().toISOString(),
    document: serializeAssemblyDocumentBody(document),
    partFiles: (options.partFiles ?? []).map(serializePartFile),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

/**
 * 四元数の 4 数を読む(§2.4)。**長さ 4・4 つとも有限の数**でなければ断る。
 *
 * 有限性まで見るのは、壊れたファイルの `NaN` / `Infinity` を通すと、そこから作った
 * 回転行列が丸ごと `NaN` になり、**画面から部品が消えた**ようにしか見えなくなるためである
 * (JSON に `NaN` は書けないので、壊れたファイルでは `null` や `1e999` として現れる)。
 */
function readRotation(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<readonly [number, number, number, number]> {
  const found = readValue(source, key, parentPath);
  if (!found.ok) {
    return found;
  }
  const path = joinPath(parentPath, key);
  if (!isUnknownArray(found.value) || found.value.length !== 4) {
    return fieldProblem(path, 'type');
  }
  const [x, y, z, w] = found.value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z) || !isFiniteNumber(w)) {
    return fieldProblem(path, 'type');
  }
  return { ok: true, value: [x, y, z, w] };
}

/** 有限の数か。`Number.isFinite` は `NaN` も `Infinity` も偽にする。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 位置の 3 数(式のまま)。長さ 3 でなければ断る。 */
function readPosition(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<readonly [ExpressionValueJson, ExpressionValueJson, ExpressionValueJson]> {
  const array = readArray(source, key, parentPath);
  if (!array.ok) {
    return array;
  }
  const path = joinPath(parentPath, key);
  if (array.value.length !== 3) {
    return fieldProblem(path, 'type');
  }
  const x = readExpressionItem(array.value[0], indexPath(path, 0));
  if (!x.ok) {
    return x;
  }
  const y = readExpressionItem(array.value[1], indexPath(path, 1));
  if (!y.ok) {
    return y;
  }
  const z = readExpressionItem(array.value[2], indexPath(path, 2));
  if (!z.ok) {
    return z;
  }
  return { ok: true, value: [x.value, y.value, z.value] };
}

function readPlacement(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<Placement> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const position = readPosition(record.value, 'position', path);
  if (!position.ok) {
    return position;
  }
  const rotation = readRotation(record.value, 'rotation', path);
  if (!rotation.ok) {
    return rotation;
  }
  return { ok: true, value: { position: position.value, rotation: rotation.value } };
}

function readMateTarget(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<MateTarget> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, MATE_TARGET_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const componentId = readString(record.value, 'componentId', path);
  if (!componentId.ok) {
    return componentId;
  }
  if (kind.value === 'origin') {
    const element = readLiteral(record.value, 'element', path, ORIGIN_ELEMENTS);
    if (!element.ok) {
      return element;
    }
    return {
      ok: true,
      value: { kind: 'origin', componentId: componentId.value, element: element.value },
    };
  }
  const found = readValue(record.value, 'ref', path);
  if (!found.ok) {
    return found;
  }
  const ref = readSubShapeRef(found.value, joinPath(path, 'ref'));
  if (!ref.ok) {
    return ref;
  }
  return {
    ok: true,
    value: { kind: 'subShape', componentId: componentId.value, ref: ref.value },
  };
}

/**
 * 置いた部品 1 つ。**外観と材質は省略できる**ので、欄が無いことは不備にしない。
 *
 * 外観に知らないプリセット・柄が入っていたとき(`readAppearanceSpec` が `null` を返す)は、
 * **その部品の色分けだけを落として読み進める**(P5 タスク5 の前方互換と同じ扱い。
 * 部品の位置は色より大事で、色が読めないだけでファイルごと開けなくしない)。
 */
function readComponent(value: unknown, path: string): Checked<AssemblyComponent> {
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
  const source = readComponentSource(record.value, 'source', path);
  if (!source.ok) {
    return source;
  }
  const placement = readPlacement(record.value, 'placement', path);
  if (!placement.ok) {
    return placement;
  }
  const fixed = readBoolean(record.value, 'fixed', path);
  if (!fixed.ok) {
    return fixed;
  }
  const visible = readBoolean(record.value, 'visible', path);
  if (!visible.ok) {
    return visible;
  }
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) {
    return suppressed;
  }
  const appearance = readOptionalAppearance(record.value, path);
  if (!appearance.ok) {
    return appearance;
  }
  const materialId = readOptionalString(record.value, 'materialId', path);
  if (!materialId.ok) {
    return materialId;
  }
  const rigidGroupId = readOptionalString(record.value, 'rigidGroupId', path);
  if (!rigidGroupId.ok) {
    return rigidGroupId;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      source: source.value,
      placement: placement.value,
      fixed: fixed.value,
      visible: visible.value,
      suppressed: suppressed.value,
      ...(appearance.value === null ? {} : { appearance: appearance.value }),
      ...(materialId.value === null ? {} : { materialId: materialId.value }),
      ...(rigidGroupId.value === null || rigidGroupId.value === '' ? {} : { rigidGroupId: rigidGroupId.value }),
    },
  };
}

/** 省略できる外観。欄が無ければ `null`(=持たない)。 */
function readOptionalAppearance(
  record: Record<string, unknown>,
  path: string,
): Checked<AppearanceSpec | null> {
  if (!('appearance' in record)) {
    return { ok: true, value: null };
  }
  return readAppearanceSpec(record, 'appearance', path);
}

/** 省略できる文字列の欄。無ければ `null`、あれば文字列であることを確かめる。 */
function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<string | null> {
  if (!(key in record)) {
    return { ok: true, value: null };
  }
  return readString(record, key, path);
}

/** 省略できる式の欄(合致の距離・角度)。無ければ `null`。 */
function readOptionalExpression(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<ExpressionValueJson | null> {
  if (!(key in record)) {
    return { ok: true, value: null };
  }
  return readExpression(record, key, path);
}

/** `null` を取り得る式の欄(ジョイントの可動範囲)。**欄そのものは必ず要る。** */
function readNullableExpression(
  record: Record<string, unknown>,
  key: string,
  path: string,
): Checked<ExpressionValueJson | null> {
  const found = readValue(record, key, path);
  if (!found.ok) {
    return found;
  }
  if (found.value === null) {
    return { ok: true, value: null };
  }
  return readExpression(record, key, path);
}

function readMate(value: unknown, path: string): Checked<Mate> {
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
  const kind = readLiteral(record.value, 'kind', path, MATE_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const a = readMateTarget(record.value, 'a', path);
  if (!a.ok) {
    return a;
  }
  const b = readMateTarget(record.value, 'b', path);
  if (!b.ok) {
    return b;
  }
  const mateValue = readOptionalExpression(record.value, 'value', path);
  if (!mateValue.ok) {
    return mateValue;
  }
  const flipped = readBoolean(record.value, 'flipped', path);
  if (!flipped.ok) {
    return flipped;
  }
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) {
    return suppressed;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      kind: kind.value,
      a: a.value,
      b: b.value,
      ...(mateValue.value === null ? {} : { value: mateValue.value }),
      flipped: flipped.value,
      suppressed: suppressed.value,
    },
  };
}

function readOccurrenceId(value: unknown, path: string): Checked<string> {
  return typeof value === 'string' && value.length > 0 ? { ok: true, value } : fieldProblem(path, 'type');
}

function readCrossLevelGearCoupling(value: unknown, path: string): Checked<CrossLevelGearCouplingDefinition> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  const kind = readLiteral(record.value, 'kind', path, CROSS_LEVEL_GEAR_KINDS);
  if (!kind.ok) return kind;
  const parentJointId = readString(record.value, 'parentJointId', path);
  if (!parentJointId.ok) return parentJointId;
  const childPath = readList(record.value, 'childPath', path, readOccurrenceId);
  if (!childPath.ok) return childPath;
  const childJointId = readString(record.value, 'childJointId', path);
  if (!childJointId.ok) return childJointId;
  const ratio = readExpression(record.value, 'ratio', path);
  if (!ratio.ok) return ratio;
  const phaseDeg = readExpression(record.value, 'phaseDeg', path);
  if (!phaseDeg.ok) return phaseDeg;
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) return suppressed;
  return { ok: true, value: { id: id.value, kind: kind.value, parentJointId: parentJointId.value, childPath: childPath.value,
    childJointId: childJointId.value, ratio: ratio.value, phaseDeg: phaseDeg.value, suppressed: suppressed.value } };
}

function readCrossLevelCamCoupling(value: unknown, path: string): Checked<CrossLevelCamCouplingDefinition> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  const kind = readLiteral(record.value, 'kind', path, CROSS_LEVEL_CAM_KINDS);
  if (!kind.ok) return kind;
  const camJointId = readString(record.value, 'camJointId', path);
  if (!camJointId.ok) return camJointId;
  const childPath = readList(record.value, 'childPath', path, readOccurrenceId);
  if (!childPath.ok) return childPath;
  const childJointId = readString(record.value, 'childJointId', path);
  if (!childJointId.ok) return childJointId;
  const discRadiusMm = readExpression(record.value, 'discRadiusMm', path);
  if (!discRadiusMm.ok) return discRadiusMm;
  const eccentricityMm = readExpression(record.value, 'eccentricityMm', path);
  if (!eccentricityMm.ok) return eccentricityMm;
  const rollerRadiusMm = readExpression(record.value, 'rollerRadiusMm', path);
  if (!rollerRadiusMm.ok) return rollerRadiusMm;
  const phaseDeg = readExpression(record.value, 'phaseDeg', path);
  if (!phaseDeg.ok) return phaseDeg;
  const offsetMm = readExpression(record.value, 'offsetMm', path);
  if (!offsetMm.ok) return offsetMm;
  // The direction is the sign of the authored law: exactly +1 or -1, never another number.
  const directionValue = readNumber(record.value, 'direction', path);
  if (!directionValue.ok) return directionValue;
  const direction = directionValue.value === 1 ? 1 : directionValue.value === -1 ? -1 : null;
  if (direction === null) return fieldProblem(joinPath(path, 'direction'), 'type');
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) return suppressed;
  return { ok: true, value: { id: id.value, kind: kind.value, camJointId: camJointId.value, childPath: childPath.value,
    childJointId: childJointId.value, discRadiusMm: discRadiusMm.value, eccentricityMm: eccentricityMm.value,
    rollerRadiusMm: rollerRadiusMm.value, phaseDeg: phaseDeg.value, offsetMm: offsetMm.value, direction,
    suppressed: suppressed.value } };
}

function readMechanismCoupling(value: unknown, path: string): Checked<MechanismGearCoupling> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  const kind = readLiteral(record.value, 'kind', path, MECHANISM_COUPLING_KINDS);
  if (!kind.ok) return kind;
  const jointAId = readString(record.value, 'jointAId', path);
  if (!jointAId.ok) return jointAId;
  const jointBId = readString(record.value, 'jointBId', path);
  if (!jointBId.ok) return jointBId;
  const ratio = readExpression(record.value, 'ratio', path);
  if (!ratio.ok) return ratio;
  const phaseDeg = readExpression(record.value, 'phaseDeg', path);
  if (!phaseDeg.ok) return phaseDeg;
  const referenceAngleA = readNumber(record.value, 'referenceAngleA', path);
  if (!referenceAngleA.ok) return referenceAngleA;
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) return suppressed;
  return { ok: true, value: { id: id.value, kind: kind.value, jointAId: jointAId.value,
    jointBId: jointBId.value, ratio: ratio.value, phaseDeg: phaseDeg.value,
    referenceAngleA: referenceAngleA.value, suppressed: suppressed.value } };
}

const CAM_COUPLING_KINDS = ['cam'] as const;

function readCamCoupling(value: unknown, path: string): Checked<MechanismCamCoupling> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  const kind = readLiteral(record.value, 'kind', path, CAM_COUPLING_KINDS);
  if (!kind.ok) return kind;
  const camJointId = readString(record.value, 'camJointId', path);
  if (!camJointId.ok) return camJointId;
  const followerJointId = readString(record.value, 'followerJointId', path);
  if (!followerJointId.ok) return followerJointId;
  const discRadiusMm = readExpression(record.value, 'discRadiusMm', path);
  if (!discRadiusMm.ok) return discRadiusMm;
  const eccentricityMm = readExpression(record.value, 'eccentricityMm', path);
  if (!eccentricityMm.ok) return eccentricityMm;
  const rollerRadiusMm = readExpression(record.value, 'rollerRadiusMm', path);
  if (!rollerRadiusMm.ok) return rollerRadiusMm;
  const phaseDeg = readExpression(record.value, 'phaseDeg', path);
  if (!phaseDeg.ok) return phaseDeg;
  const referenceAngleCam = readNumber(record.value, 'referenceAngleCam', path);
  if (!referenceAngleCam.ok) return referenceAngleCam;
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) return suppressed;
  return { ok: true, value: { id: id.value, kind: kind.value, camJointId: camJointId.value,
    followerJointId: followerJointId.value, discRadiusMm: discRadiusMm.value, eccentricityMm: eccentricityMm.value,
    rollerRadiusMm: rollerRadiusMm.value, phaseDeg: phaseDeg.value, referenceAngleCam: referenceAngleCam.value,
    suppressed: suppressed.value } };
}

function readJoint(value: unknown, path: string): Checked<Joint> {
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
  const kind = readLiteral(record.value, 'kind', path, JOINT_KINDS);
  if (!kind.ok) {
    return kind;
  }
  const a = readMateTarget(record.value, 'a', path);
  if (!a.ok) {
    return a;
  }
  const b = readMateTarget(record.value, 'b', path);
  if (!b.ok) {
    return b;
  }
  const minValue = readNullableExpression(record.value, 'minValue', path);
  if (!minValue.ok) {
    return minValue;
  }
  const maxValue = readNullableExpression(record.value, 'maxValue', path);
  if (!maxValue.ok) {
    return maxValue;
  }
  const suppressed = readBoolean(record.value, 'suppressed', path);
  if (!suppressed.ok) {
    return suppressed;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      kind: kind.value,
      a: a.value,
      b: b.value,
      minValue: minValue.value,
      maxValue: maxValue.value,
      suppressed: suppressed.value,
    },
  };
}

function readPresentationBody(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<PresentationStep['body']> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const kind = readLiteral(record.value, 'kind', path, PRESENTATION_BODY_KINDS);
  if (!kind.ok) {
    return kind;
  }
  if (kind.value === 'explode') {
    const componentIds = readList(record.value, 'componentIds', path, readStringItem);
    if (!componentIds.ok) {
      return componentIds;
    }
    // 分解の向きは P5 の `AxisSpec`(= `RevolveAxis`)を流用する(§0.a-0.36)ので、
    // 読み手も回転軸のものをそのまま使う(同じ書式を 2 か所に書かない)。
    const direction: Checked<AxisSpec> = readRevolveAxis(record.value, 'direction', path);
    if (!direction.ok) {
      return direction;
    }
    const distance = readExpression(record.value, 'distance', path);
    if (!distance.ok) {
      return distance;
    }
    return {
      ok: true,
      value: {
        kind: 'explode',
        componentIds: componentIds.value,
        direction: direction.value,
        distance: distance.value,
      },
    };
  }
  const jointId = readString(record.value, 'jointId', path);
  if (!jointId.ok) {
    return jointId;
  }
  const from = readExpression(record.value, 'from', path);
  if (!from.ok) {
    return from;
  }
  const to = readExpression(record.value, 'to', path);
  if (!to.ok) {
    return to;
  }
  let coordinate: 'angle' | 'translation' | undefined;
  if (Object.hasOwn(record.value, 'coordinate')) {
    const checked = readLiteral(record.value, 'coordinate', path, ['angle', 'translation'] as const);
    if (!checked.ok) return checked;
    coordinate = checked.value;
  }
  let referenceAngle: number | undefined;
  if (Object.hasOwn(record.value, 'referenceAngle')) {
    const checked = readNumber(record.value, 'referenceAngle', path);
    if (!checked.ok) return checked;
    referenceAngle = checked.value;
  }
  return {
    ok: true,
    value: {
      kind: 'joint',
      jointId: jointId.value,
      from: from.value,
      to: to.value,
      ...(coordinate === undefined ? {} : { coordinate }),
      ...(referenceAngle === undefined ? {} : { referenceAngle }),
    },
  };
}

/** 文字列の並び(部品 id の一覧)の 1 件。`readList` へ渡す値用の読み手。 */
function readStringItem(value: unknown, path: string): Checked<string> {
  if (typeof value !== 'string') {
    return fieldProblem(path, 'type');
  }
  return { ok: true, value };
}

function readPresentationStep(value: unknown, path: string): Checked<PresentationStep> {
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
  const start = readNumber(record.value, 'start', path);
  if (!start.ok) {
    return start;
  }
  const end = readNumber(record.value, 'end', path);
  if (!end.ok) {
    return end;
  }
  if (!Number.isFinite(start.value) || !Number.isFinite(end.value)
    || start.value < 0 || end.value > 1 || start.value >= end.value) {
    return fieldProblem(joinPath(path, 'start'), 'type');
  }
  const body = readPresentationBody(record.value, 'body', path);
  if (!body.ok) {
    return body;
  }
  return {
    ok: true,
    value: {
      id: id.value,
      name: name.value,
      start: start.value,
      end: end.value,
      body: body.value,
    },
  };
}

/**
 * 部品表の列(FR-611)。`BOM_COLUMN_IDS`(model が正本)に無い名前は断る。
 * `readLiteral` は欄用なので、配列の要素にはこの値用の読み手を使う
 * (`readVec3Item` / `readVec3` と同じ、値用と欄用の組)。
 */
function readBomColumn(value: unknown, path: string): Checked<BomColumnId> {
  for (const candidate of BOM_COLUMN_IDS) {
    if (candidate === value) {
      return { ok: true, value: candidate };
    }
  }
  return fieldProblem(path, 'type');
}

function readBomSettings(
  source: Record<string, unknown>,
  key: string,
  parentPath: string,
): Checked<BomSettings> {
  const record = readRecord(source, key, parentPath);
  if (!record.ok) {
    return record;
  }
  const path = joinPath(parentPath, key);
  const columns = readList(record.value, 'columns', path, readBomColumn);
  if (!columns.ok) {
    return columns;
  }
  const sortBy: Checked<BomSortKey> = readLiteral(record.value, 'sortBy', path, BOM_SORT_KEYS);
  if (!sortBy.ok) {
    return sortBy;
  }
  const expandSubAssemblies = readBoolean(record.value, 'expandSubAssemblies', path);
  if (!expandSubAssemblies.ok) {
    return expandSubAssemblies;
  }
  return {
    ok: true,
    value: {
      columns: columns.value,
      sortBy: sortBy.value,
      expandSubAssemblies: expandSubAssemblies.value,
    },
  };
}

/** 結び付けの先の鍵(部品の ref と基準点 id)。先が抱き込んだ部品でなければ null。 */
function contextTargetKey(document: AssemblyDocument, link: ContextReferenceLink): string | null {
  const component = document.components.find((candidate) => candidate.id === link.targetComponentId);
  return component === undefined || component.source.kind !== 'part' ? null
    : JSON.stringify([component.source.partRef, link.targetReferenceId]);
}

function readContextReference(value: unknown, path: string): Checked<ContextReferenceLink> {
  const record = checkRecord(value, path);
  if (!record.ok) return record;
  const id = readString(record.value, 'id', path);
  if (!id.ok) return id;
  const targetComponentId = readString(record.value, 'targetComponentId', path);
  if (!targetComponentId.ok) return targetComponentId;
  const targetReferenceId = readString(record.value, 'targetReferenceId', path);
  if (!targetReferenceId.ok) return targetReferenceId;
  const sourceComponentId = readString(record.value, 'sourceComponentId', path);
  if (!sourceComponentId.ok) return sourceComponentId;
  const found = readValue(record.value, 'source', path);
  if (!found.ok) return found;
  const source = readSubShapeRef(found.value, joinPath(path, 'source'));
  if (!source.ok) return source;
  return { ok: true, value: { id: id.value, targetComponentId: targetComponentId.value,
    targetReferenceId: targetReferenceId.value, sourceComponentId: sourceComponentId.value, source: source.value } };
}

function readAssemblyDocumentBody(value: unknown, path: string): Checked<AssemblyDocument> {
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
  const components = readList(record.value, 'components', path, readComponent);
  if (!components.ok) {
    return components;
  }
  const mates = readList(record.value, 'mates', path, readMate);
  if (!mates.ok) {
    return mates;
  }
  const joints = readList(record.value, 'joints', path, readJoint);
  if (!joints.ok) {
    return joints;
  }
  const occurrenceConnections: Checked<readonly JointOccurrenceConnection[] | undefined> = Object.hasOwn(record.value, 'jointOccurrenceConnections')
    ? readJointOccurrenceConnections(record.value['jointOccurrenceConnections'], components.value,
      joinPath(path, 'jointOccurrenceConnections'))
    : { ok: true, value: undefined };
  if (!occurrenceConnections.ok) return occurrenceConnections;
  const boltedJoints: Checked<readonly import('@pointercad/model').BoltedJointRecord[] | undefined> =
    Object.hasOwn(record.value, 'boltedJoints')
      ? readBoltedJointRecords(record.value['boltedJoints'], components.value, joinPath(path, 'boltedJoints'))
      : { ok: true, value: undefined };
  if (!boltedJoints.ok) return boltedJoints;
  const mechanismCouplings: Checked<readonly MechanismGearCoupling[] | undefined> =
    record.value['mechanismCouplings'] === undefined ? { ok: true, value: undefined }
      : readList(record.value, 'mechanismCouplings', path, readMechanismCoupling);
  if (!mechanismCouplings.ok) return mechanismCouplings;
  const camCouplings: Checked<readonly MechanismCamCoupling[] | undefined> =
    record.value['camCouplings'] === undefined ? { ok: true, value: undefined }
      : readList(record.value, 'camCouplings', path, readCamCoupling);
  if (!camCouplings.ok) return camCouplings;
  const crossLevelGearCouplings: Checked<readonly CrossLevelGearCouplingDefinition[] | undefined> =
    record.value['crossLevelGearCouplings'] === undefined ? { ok: true, value: undefined }
      : readList(record.value, 'crossLevelGearCouplings', path, readCrossLevelGearCoupling);
  if (!crossLevelGearCouplings.ok) return crossLevelGearCouplings;
  const crossLevelCamCouplings: Checked<readonly CrossLevelCamCouplingDefinition[] | undefined> =
    record.value['crossLevelCamCouplings'] === undefined ? { ok: true, value: undefined }
      : readList(record.value, 'crossLevelCamCouplings', path, readCrossLevelCamCoupling);
  if (!crossLevelCamCouplings.ok) return crossLevelCamCouplings;
  const contextReferences: Checked<readonly ContextReferenceLink[] | undefined> =
    record.value['contextReferences'] === undefined ? { ok: true, value: undefined }
      : readList(record.value, 'contextReferences', path, readContextReference);
  if (!contextReferences.ok) return contextReferences;
  const presentation = readList(record.value, 'presentation', path, readPresentationStep);
  if (!presentation.ok) {
    return presentation;
  }
  const parameters: Checked<readonly Parameter[]> = readList(
    record.value,
    'parameters',
    path,
    readParameter,
  );
  if (!parameters.ok) {
    return parameters;
  }
  const bom = readBomSettings(record.value, 'bom', path);
  if (!bom.ok) {
    return bom;
  }
  const beamAnalysisInputs = readOptionalBeamAnalysisInputs(record.value, id.value, 'assembly', path);
  if (!beamAnalysisInputs.ok) return beamAnalysisInputs;
  const namedViews = readNamedViews(record.value, path);
  if (!namedViews.ok) return namedViews;
  const document: AssemblyDocument = {
      id: id.value,
      name: name.value,
      schemaVersion: schemaVersion.value,
      ...(occurrenceConnections.value === undefined ? {} : { jointOccurrenceConnections: occurrenceConnections.value }),
      ...(boltedJoints.value === undefined ? {} : { boltedJoints: boltedJoints.value }),
      ...(beamAnalysisInputs.value === undefined ? {} : { beamAnalysisInputs: beamAnalysisInputs.value }),
      components: components.value,
      mates: mates.value,
      joints: joints.value,
      ...(mechanismCouplings.value === undefined ? {} : { mechanismCouplings: mechanismCouplings.value }),
      ...(camCouplings.value === undefined ? {} : { camCouplings: camCouplings.value }),
      ...(crossLevelGearCouplings.value === undefined ? {} : { crossLevelGearCouplings: crossLevelGearCouplings.value }),
      ...(crossLevelCamCouplings.value === undefined ? {} : { crossLevelCamCouplings: crossLevelCamCouplings.value }),
      ...(contextReferences.value === undefined ? {} : { contextReferences: contextReferences.value }),
      presentation: presentation.value,
      parameters: parameters.value,
      bom: bom.value,
      namedViews: namedViews.value,
  };
  const evaluated = evaluateMechanismCouplings(document);
  if (!evaluated.ok) return fieldProblem(joinPath(path, 'mechanismCouplings'), 'type');
  const ids = new Set<string>(), pairs = new Set<string>();
  for (const c of evaluated.couplings) {
    const couplingPath = joinPath(path, 'mechanismCouplings');
    if (c.id.length === 0 || ids.has(c.id) || c.ratio === 0 || !Number.isFinite(1 / c.ratio)
        || !Number.isFinite(-c.phaseDeg / c.ratio)
        || !Number.isFinite(c.ratio * c.referenceAngleA + c.phaseDeg))
      return fieldProblem(couplingPath, 'type');
    ids.add(c.id);
    const a = document.joints.filter(j => j.id === c.jointAId);
    const b = document.joints.filter(j => j.id === c.jointBId);
    const pair = JSON.stringify([c.jointAId, c.jointBId].sort());
    if (c.jointAId === c.jointBId || a.length !== 1 || b.length !== 1
        || a[0]?.kind !== 'revolute' || b[0]?.kind !== 'revolute'
        || (!c.suppressed && (a[0]?.suppressed === true || b[0]?.suppressed === true || pairs.has(pair))))
      return fieldProblem(couplingPath, 'type');
    if (!c.suppressed) pairs.add(pair);
  }
  if (mechanismCouplingLoopFailure(evaluated.couplings) !== null)
    return fieldProblem(joinPath(path, 'mechanismCouplings'), 'type');
  // Cam relations: structural admission only (frames/in-line geometry are checked by the solver, which keeps the
  // original scene on refusal). One cam per follower; a follower may not also be an active gear joint.
  const cams = evaluateCamCouplings(document), camPath = joinPath(path, 'camCouplings');
  if (!cams.ok) return fieldProblem(camPath, 'type');
  const gearJointIds = new Set(evaluated.couplings.filter(c => !c.suppressed).flatMap(c => [c.jointAId, c.jointBId]));
  const followers = new Set<string>();
  for (const c of cams.couplings) {
    const cam = document.joints.filter(j => j.id === c.camJointId);
    const follower = document.joints.filter(j => j.id === c.followerJointId);
    if (c.id.length === 0 || ids.has(c.id) || camDimensionFailure(c) !== null || c.camJointId === c.followerJointId
        || cam.length !== 1 || follower.length !== 1 || cam[0]?.kind !== 'revolute' || follower[0]?.kind !== 'slider'
        || (!c.suppressed && (cam[0]?.suppressed === true || follower[0]?.suppressed === true
          || followers.has(c.followerJointId) || gearJointIds.has(c.followerJointId))))
      return fieldProblem(camPath, 'type');
    ids.add(c.id);
    if (!c.suppressed) followers.add(c.followerJointId);
  }
  // Cross-level gears: what this document can check alone; the subassembly tree is checked by the .pcada reader.
  if (crossLevelGearDocumentFailure(document) !== null) return fieldProblem(joinPath(path, 'crossLevelGearCouplings'), 'type');
  // Cross-level cams likewise (together with the gears: one relation per placement and per parent joint).
  if (crossLevelCamDocumentFailure(document) !== null) return fieldProblem(joinPath(path, 'crossLevelCamCouplings'), 'type');
  const contextIds = new Set<string>(), contextTargets = new Set<string>();
  for (const link of document.contextReferences ?? []) {
    const target = contextTargetKey(document, link);
    if (link.id.length === 0 || contextIds.has(link.id) || target === null || contextTargets.has(target)
        || link.targetComponentId === link.sourceComponentId
        || !document.components.some((component) => component.id === link.sourceComponentId))
      return fieldProblem(joinPath(path, 'contextReferences'), 'type');
    contextIds.add(link.id);
    contextTargets.add(target);
  }
  // 部品の単位の循環(同じ部品の別の配置を通るものも)は、確定の時と同じ判定で開かずに断る。形は計算しない。
  if (contextReferencesHaveCycle(document, document.contextReferences ?? [])) {
    return fieldProblem(joinPath(path, 'contextReferences'), 'type');
  }
  return { ok: true, value: document };
}

/** 抱き込んだ部品 1 つの素性。5 欄すべてを厳密に検査する。 */
function readPartFile(value: unknown, path: string): Checked<PcadPartFile> {
  const record = checkRecord(value, path);
  if (!record.ok) {
    return record;
  }
  const ref = readString(record.value, 'ref', path);
  if (!ref.ok) {
    return ref;
  }
  const fileName = readString(record.value, 'fileName', path);
  if (!fileName.ok) {
    return fileName;
  }
  const filePath = readString(record.value, 'path', path);
  if (!filePath.ok) {
    return filePath;
  }
  const contentHash = readString(record.value, 'contentHash', path);
  if (!contentHash.ok) {
    return contentHash;
  }
  const importedAt = readString(record.value, 'importedAt', path);
  if (!importedAt.ok) {
    return importedAt;
  }
  return {
    ok: true,
    value: {
      ref: ref.value,
      fileName: fileName.value,
      path: filePath.value,
      contentHash: contentHash.value,
      importedAt: importedAt.value,
    },
  };
}

// ---------------------------------------------------------------------------
// 読み込みの入口と断り方(FR-504、NFR-UX-5)
// ---------------------------------------------------------------------------

export type ReadAssemblyDocumentResult =
  | {
      readonly ok: true;
      readonly document: AssemblyDocument;
      readonly savedAt: string;
      /** 封筒に書かれていた種別。アセンブリは 1 値しかないが、部品の読み手と形をそろえる。 */
      readonly kind: PcadAssemblyKind;
      /** 抱き込んだ部品の素性(要件§8)。無ければ空の一覧。 */
      readonly partFiles: readonly PcadPartFile[];
    }
  | { readonly ok: false; readonly error: ParseError };

/**
 * 断りの文言は**部品の読み手(`documentJson.ts`)とそろえてある。**
 * 「PointerCAD のファイルではあるが、この種類ではない」だけは中身が違うので書き分ける
 * (部品の読み手は「まだ対応していません」と言うが、アセンブリは実装済みで、
 * 断る理由は「これはアセンブリではない」であるため)。
 */
const NOT_ASSEMBLY_MESSAGE = 'PointerCAD のアセンブリファイルではないようです。';

function fail(code: ParseErrorCode, message: string): ReadAssemblyDocumentResult {
  return { ok: false, error: { code, message } };
}

/** 欄の不備を、場所を添えた日本語にする(`documentJson.ts` の `failField` と同じ文言)。 */
function failField(problem: FieldProblem): ReadAssemblyDocumentResult {
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
 * id が一覧の中で重なっていないことを確かめる(重なっていれば最初の 1 つを返す)。
 * 部品・合致・ジョイント・ステップの id は互いを指し合う鍵なので、重なると
 * どちらを指しているかが決まらない(`documentJson.ts` の `findDuplicateId` と同じ理由)。
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

/** 重なった id を見つけたら、どの一覧かを添えて断る。 */
function failDuplicateId(label: string, id: string): ReadAssemblyDocumentResult {
  return fail(
    'invalidField',
    `${label}の id が重なっています(${id})。ファイルが壊れている可能性があります。`,
  );
}

/** 保存文書内の id 参照が実在するかを確かめ、最初の壊れた欄を返す。 */
function brokenReferencePath(document: AssemblyDocument): string | null {
  const componentIds = new Set(document.components.map((component) => component.id));
  for (const [index, mate] of document.mates.entries()) {
    if (!componentIds.has(mate.a.componentId)) return `document.mates[${String(index)}].a.componentId`;
    if (!componentIds.has(mate.b.componentId)) return `document.mates[${String(index)}].b.componentId`;
  }
  const jointIds = new Set(document.joints.map((joint) => joint.id));
  for (const [index, joint] of document.joints.entries()) {
    if (!componentIds.has(joint.a.componentId)) return `document.joints[${String(index)}].a.componentId`;
    if (!componentIds.has(joint.b.componentId)) return `document.joints[${String(index)}].b.componentId`;
  }
  for (const [index, step] of document.presentation.entries()) {
    if (step.body.kind === 'joint') {
      if (!jointIds.has(step.body.jointId)) return `document.presentation[${String(index)}].body.jointId`;
      continue;
    }
    for (const [componentIndex, componentId] of step.body.componentIds.entries()) {
      if (!componentIds.has(componentId)) {
        return `document.presentation[${String(index)}].body.componentIds[${String(componentIndex)}]`;
      }
    }
    if (findDuplicateId(step.body.componentIds) !== null) {
      return `document.presentation[${String(index)}].body.componentIds`;
    }
  }
  return null;
}

/** 版の判定が済んだ封筒を読む。 */
function readEnvelope(
  raw: Record<string, unknown>,
  schema: number,
): ReadAssemblyDocumentResult {
  const app = readString(raw, 'app', '');
  if (!app.ok || app.value !== PCAD_APP_NAME) {
    return fail('notPcad', NOT_ASSEMBLY_MESSAGE);
  }
  // 種別は封筒の欄なので、中身を読む前に見る(部品の読み手と同じ順)。
  const kind = readString(raw, 'kind', '');
  if (!kind.ok) {
    return fail('notPcad', NOT_ASSEMBLY_MESSAGE);
  }
  if (!isAssemblyKind(kind.value)) {
    return fail('unsupportedKind', `このファイルはアセンブリではありません(種類 ${kind.value})。`);
  }
  const savedAt = readString(raw, 'savedAt', '');
  if (!savedAt.ok) {
    return failField(savedAt.problem);
  }
  const document = readValue(raw, 'document', '');
  if (!document.ok) {
    return failField(document.problem);
  }
  const decoded = readAssemblyDocumentBody(document.value, 'document');
  if (!decoded.ok) {
    return failField(decoded.problem);
  }
  if (decoded.value.schemaVersion !== schema) {
    return fail(
      'versionMismatch',
      `ファイルの版の記録が食い違っています(封筒 ${String(schema)} / 文書 ${String(decoded.value.schemaVersion)})。`,
    );
  }
  const partFiles = readList(raw, 'partFiles', '', readPartFile);
  if (!partFiles.ok) {
    return failField(partFiles.problem);
  }
  const duplicateComponentId = findDuplicateId(
    decoded.value.components.map((component) => component.id),
  );
  if (duplicateComponentId !== null) {
    return failDuplicateId('部品', duplicateComponentId);
  }
  const duplicateMateId = findDuplicateId(decoded.value.mates.map((mate) => mate.id));
  if (duplicateMateId !== null) {
    return failDuplicateId('合致', duplicateMateId);
  }
  const duplicateJointId = findDuplicateId(decoded.value.joints.map((joint) => joint.id));
  if (duplicateJointId !== null) {
    return failDuplicateId('ジョイント', duplicateJointId);
  }
  const duplicateStepId = findDuplicateId(decoded.value.presentation.map((step) => step.id));
  if (duplicateStepId !== null) {
    return failDuplicateId('分解のステップ', duplicateStepId);
  }
  const duplicatePartRef = findDuplicateId(partFiles.value.map((partFile) => partFile.ref));
  if (duplicatePartRef !== null) {
    return failDuplicateId('抱き込んだ部品', duplicatePartRef);
  }
  const brokenReference = brokenReferencePath(decoded.value);
  if (brokenReference !== null) {
    return fail('invalidField', `ファイルの中身が壊れています(${brokenReference} の参照先が見つかりません)。`);
  }
  return {
    ok: true,
    document: decoded.value,
    savedAt: savedAt.value,
    kind: kind.value,
    partFiles: partFiles.value,
  };
}

/**
 * 封筒の `kind` がアセンブリかを確かめる。`Array.includes` は引数の型を一覧の型へ
 * 狭めてしまい `as` が要るので、自前の型ガードで書く(**`as` / `any` を使わない**)。
 */
function isAssemblyKind(value: string): value is PcadAssemblyKind {
  for (const candidate of PCAD_ASSEMBLY_KINDS) {
    if (candidate === value) {
      return true;
    }
  }
  return false;
}

/**
 * 移行を試みる前に、封筒の版と文書自身が持つ版が食い違っていないかを確かめる
 * (`documentJson.ts` の `envelopeDocumentVersionMismatch` と同じ理由。移行の各段は
 * `schemaVersion` を無条件に書き換えるので、先に確かめないと食い違いを握りつぶす)。
 */
function envelopeDocumentVersionMismatch(
  raw: Record<string, unknown>,
  schema: number,
): ReadAssemblyDocumentResult | null {
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

/** 封筒の `schema` を先に検査してから中身を読む(部品の `decodeFile` と同じ段取り)。 */
function decodeFile(raw: unknown): ReadAssemblyDocumentResult {
  if (!isRecord(raw)) {
    return fail('notPcad', NOT_ASSEMBLY_MESSAGE);
  }
  const schema = readNumber(raw, 'schema', '');
  if (!schema.ok) {
    return fail('notPcad', NOT_ASSEMBLY_MESSAGE);
  }
  if (schema.value > PCAD_SCHEMA_VERSION) {
    return fail(
      'unsupportedNewVersion',
      `このファイルは新しい版の PointerCAD で保存されています(版 ${String(schema.value)})。アプリを更新してください。`,
    );
  }
  if (schema.value < PCAD_SCHEMA_VERSION) {
    // 移行先(`SCHEMA_MIGRATIONS[schema.value]`)が無い版(例: 版 1)は、この時点では
    // まだ移行を試みないので、文書側の版と比べても意味が無い(必ず unsupportedOldVersion に
    // なるべきところを versionMismatch にすり替えない)。移行が実在する版だけ検査する
    // (`documentJson.ts` の `decodeFile` と同じ決め)。
    if (SCHEMA_MIGRATIONS[schema.value] !== undefined) {
      const mismatch = envelopeDocumentVersionMismatch(raw, schema.value);
      if (mismatch !== null) {
        return mismatch;
      }
    }
    const lifted = migrateToCurrentSchema(raw, schema.value);
    if (lifted === null) {
      return fail(
        'unsupportedOldVersion',
        `対応していない古い版です(版 ${String(schema.value)})。`,
      );
    }
    return readEnvelope(lifted, PCAD_SCHEMA_VERSION);
  }
  return readEnvelope(raw, schema.value);
}

/**
 * `.pcada` の `document.json` の中身からアセンブリ文書を読む。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
export function readAssemblyDocument(text: string): ReadAssemblyDocumentResult {
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return fail(
      'invalidJson',
      'ファイルの中身を読み取れませんでした。PointerCAD のファイルか確かめてください。',
    );
  }
  return decodeFile(parsed.value);
}
