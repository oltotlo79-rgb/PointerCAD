/**
 * アセンブリ文書の生成と採番(計画書 docs/plans/P7-アセンブリ.md タスク1、§2.2)。
 *
 * `part/createPartDocument.ts` とまったく同じ流儀にする——履歴を書き換えず、変更のたびに
 * 新しい配列を作る。Undo / Redo(FR-505)はこの不変性の上に乗る。
 *
 * ここに置くのは「空の文書を作る」ことと「次の id を決める」ことだけで、部品を置く・消す・
 * 固定する・表示を切り替えるといった履歴操作は `assembly/assemblyEdit.ts`(P7 タスク7)、
 * 解決(形の再計算と配置の合成)は `assembly/resolveAssembly.ts`(P7 タスク6)の担当にする。
 */

import { createDefaultNamedViews } from '../part/namedViews.js';
import { expressionValueFromNumber } from '@pointercad/expression';

import { PART_SCHEMA_VERSION } from '../part/createPartDocument.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';

import type {
  AssemblyDocument,
  BomColumnId,
  BomSettings,
  BomSortKey,
  JointKind,
  MateKind,
  Placement,
  StandardCatalogId,
} from './types.js';

/**
 * アセンブリ文書の保存形式の版(§0.a-0.2)。
 *
 * **部品とアセンブリで版の系列を分けない**(取り違えの判定を 1 か所で済ませるため)。
 * したがって `PART_SCHEMA_VERSION` をそのまま使い、数を写して 2 か所に持たない。
 * 封筒(`packages/io/src/pcad/schema.ts` の `PCAD_SCHEMA_VERSION`)もこの数と揃える
 * (P7 タスク3 が `kind: 'assembly'` を足すときに同じ数へ上げる)。
 */
export const ASSEMBLY_SCHEMA_VERSION = PART_SCHEMA_VERSION;

/**
 * 新しいアセンブリの既定の名前。
 * `createEmptyPartDocument` の「部品1」と同じく**ドキュメントの既定データ**として
 * ここに置く(UI 文字列の `ja.json` とは別扱い。`createSketchDocument.ts` の注釈と同じ)。
 */
export const DEFAULT_ASSEMBLY_NAME = '組立1';

/**
 * 何も指定せずに部品を置いたときの配置。原点に、回さずに置く。
 * 位置は式のまま持つので、あとからプロパティで式に直せる(FR-202)。
 *
 * 向きは単位四元数 `(0, 0, 0, 1)`(`qw = cos(0) = 1`)で、**`qw >= 0` の規約**
 * (§0.a-0.54)を満たす。式を数へ解いた後の配置(`RigidPlacement`)と、その単位元
 * `IDENTITY_PLACEMENT` は `assembly/placementMath.ts`(P7 タスク2)の担当で、
 * **保存される形はこちら、計算に使う形はあちら**と役割を分ける。
 */
export const DEFAULT_COMPONENT_PLACEMENT: Placement = {
  position: [
    expressionValueFromNumber(0),
    expressionValueFromNumber(0),
    expressionValueFromNumber(0),
  ],
  rotation: [0, 0, 0, 1],
};

/**
 * 合致の種類の一覧(§0.a-0.13)。読み書き(P7 タスク3)が「知らない種類」を断るときの
 * 正本にする(同じ一覧を 2 か所に書かない。`parameters/types.ts` の `PARAMETER_UNITS` と同じ流儀)。
 */
export const MATE_KINDS: readonly MateKind[] = [
  'coincident',
  'concentric',
  'distance',
  'angle',
  'parallel',
  'tangent',
];

/** ジョイントの種類の一覧(§0.a-0.22)。用途は `MATE_KINDS` と同じ。 */
export const JOINT_KINDS: readonly JointKind[] = ['revolute', 'slider', 'cylindrical', 'ball'];

/**
 * 規格部品の種類の一覧(§0.a-0.30〜0.35)。用途は `MATE_KINDS` と同じ。
 * **寸法表(行と数値)は `assembly/standard/**`(P7 タスク27・28)が持つ。**
 */
export const STANDARD_CATALOG_IDS: readonly StandardCatalogId[] = [
  'hexBolt',
  'hexNut',
  'plainWasher',
  'springWasher',
  'socketHeadCapScrew',
  'panHeadScrew',
  'deepGrooveBallBearing',
  'equalAngle',
  'channel',
  'hBeam',
];

/** 部品表の列の一覧(FR-611 の 4 列 + 質量。§0.a-0.38)。並びが既定の列順でもある。 */
export const BOM_COLUMN_IDS: readonly BomColumnId[] = [
  'number',
  'name',
  'quantity',
  'material',
  'mass',
  'configuration',
];

/** 部品表の並べ替えの基準の一覧(§2.10)。 */
export const BOM_SORT_KEYS: readonly BomSortKey[] = ['number', 'name', 'quantity', 'mass'];

/**
 * 部品表の既定(§0.a-0.38、§2.10)。5 列すべてを番号順で出し、
 * サブアセンブリは中身を展開せず 1 行として数える。
 */
export const DEFAULT_BOM_SETTINGS: BomSettings = {
  columns: ['number', 'name', 'quantity', 'material', 'mass'],
  sortBy: 'number',
  expandSubAssemblies: false,
};

/**
 * 空のアセンブリ文書(FR-601)。**部品を 1 つも置いていない状態**で始まる。
 *
 * 部品文書の `createEmptyPartDocument` が空のスケッチを 1 本持つのと違い、
 * こちらは中身を何も作らない——アセンブリは「部品を取り込んで置く」ところから始まり、
 * 空の入れ物を先に用意しても利用者にできることが増えないためである(NFR-UX-6)。
 */
export function createAssemblyDocument(name: string): AssemblyDocument {
  return {
    id: 'assembly-1',
    name,
    schemaVersion: ASSEMBLY_SCHEMA_VERSION,
    components: [],
    mates: [],
    joints: [],
    presentation: [],
    // パラメータ表(FR-207)の既定は空。名前を付けた数値は利用者が足す(部品文書と同じ)。
    parameters: [],
    bom: DEFAULT_BOM_SETTINGS,
    namedViews: createDefaultNamedViews(),
  };
}

/*
  採番(§0.a-0.19 と同じ方式)。

  既存の id の最大連番 + 1 を返すので、**途中のものを消しても番号を再利用しない。**
  「component-1」「component-2」「component-3」から 2 つ目を消して 1 つ足すと「component-4」に
  なり、消えた部品を指していた合致(id で指している)と取り違えることがない。
  全部消せば 1 に戻るが、そのとき重複する相手はいない。
*/

/** 次の部品(インスタンス)の id。`component-<n>`。 */
export function nextComponentId(document: AssemblyDocument): string {
  return nextSerialId(
    document.components.map((component) => component.id),
    'component-',
  );
}

/** 次の合致の id。`mate-<n>`。 */
export function nextMateId(document: AssemblyDocument): string {
  return nextSerialId(
    document.mates.map((mate) => mate.id),
    'mate-',
  );
}

/** 次のジョイントの id。`joint-<n>`。 */
export function nextJointId(document: AssemblyDocument): string {
  return nextSerialId(
    document.joints.map((joint) => joint.id),
    'joint-',
  );
}

/** 次の分解・アニメーションのステップの id。`step-<n>`。 */
export function nextPresentationStepId(document: AssemblyDocument): string {
  return nextSerialId(
    document.presentation.map((step) => step.id),
    'step-',
  );
}
