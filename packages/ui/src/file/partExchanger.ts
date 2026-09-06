/**
 * 書き出し・読み込みの橋渡し(計画書 docs/plans/P6-入出力.md §2.4・§2.5・§2.5.1・§2.8、
 * §0.a-0.19・0.22、タスク32b)。
 *
 * 対応要件: FR-802(読み込み)、FR-803(書き出し)、FR-804(名前と色)、FR-1106(外観)、
 * NFR-MA-1(依存の向き)、NFR-RE-1(止めずに警告する)。
 *
 * **タスク32 が空けておいた口(`ExchangeKernel`)を埋める場所。** 手続き
 * (`exchangeFile.ts`)は「何を書き出すか」まで決めてくれるが、幾何カーネルは
 * **段の鍵**(`ResolvedSolidStep.key`)でしか形を引けないので、ここで
 * ①文書を解き直して鍵を作り(`resolveCachedSteps`。測定と同じ解き方)、
 * ②履歴の名前と外観の割り当てから**書き込む名前と色**を組み(`bodyColorsFor` /
 *   `faceColorsFor`)、
 * ③model の橋(`KernelBridge.exportShapes` / `importShape`)へ渡す。
 *
 * **DOM にもストアにも触れない。** 今の文書と外観の照合は `snapshot()` で受け取り、
 * カーネルの口も関数で受ける(`createPartMeasurer` と同じ流儀)。判断を Node の単体検査で
 * 固定できるようにするため。配線するのは `app/PointerCadApp.tsx` の 1 か所だけ。
 *
 * **`packages/ui` は幾何カーネルを輸入しない**(依存の向きは `ui → model → kernel`)。
 * 依頼と結果の言葉はすべて model の型(`ShapeExportOptions` / `ShapeImportOutcome`)である。
 */

import {
  bodyColorsFor,
  faceColorsFor,
  rgbTupleOf,
  type AppearanceMatchEntry,
  type ExportColor,
  type ImportedBody,
  type PartDocument,
  type ResolvedSolidStep,
  type RgbColor,
  type ShapeExportBody,
  type ShapeExportOptions,
  type ShapeExportOutcome,
  type ShapeImportOptions,
  type ShapeImportOutcome,
} from '@pointercad/model';

import { resolveCachedSteps, type CachedResolveDeps } from '../solid/resolveCachedSteps.js';
import type {
  ExchangeExportOutcome,
  ExchangeExportRequest,
  ExchangeImportedBody,
  ExchangeImportOutcome,
  ExchangeKernel,
} from './exchangeFile.js';

/**
 * 書き出すときに読む「今」の中身。
 *
 * **文書と外観の照合の 2 つだけ**を受け取る。照合(`appearanceMatches`)は再計算のたびに
 * 返っている面の通し番号で、面ごとの色を組むのに要る(`faceColorsFor`。照合をここで
 * やり直さない、§2.5.1)。
 */
export interface PartExchangeSnapshot {
  readonly document: PartDocument;
  readonly appearanceMatches: readonly AppearanceMatchEntry[];
}

/** `createPartExchanger` に渡すもの。覚え書きは再計算・測定と同じものを持ち回る(NFR-PF-2)。 */
export interface PartExchangerDeps extends CachedResolveDeps {
  /** 今の文書と外観の照合を読む(ストアの値をそのまま返す)。 */
  readonly snapshot: () => PartExchangeSnapshot;
  /** 形を書き出す口(`KernelBridge.exportShapes`)。 */
  readonly exportShapes: (
    steps: readonly ResolvedSolidStep[],
    options: ShapeExportOptions,
  ) => Promise<ShapeExportOutcome>;
  /** 形を読み込む口(`KernelBridge.importShape`)。 */
  readonly importShape: (options: ShapeImportOptions) => Promise<ShapeImportOutcome>;
}

/** 面ごとの色を、カーネルへ渡す組(sRGB の 0〜1)の表へ直す。 */
function toFaceColorTuples(
  faces: ReadonlyMap<number, RgbColor>,
): ReadonlyMap<number, ExportColor> {
  const tuples = new Map<number, ExportColor>();
  for (const [faceIndex, color] of faces) {
    tuples.set(faceIndex, rgbTupleOf(color));
  }
  return tuples;
}

/**
 * 書き出す立体 1 つずつに、**ファイルへ書き込む名前と色**を添える(FR-804、FR-1106)。
 *
 * - 名前は履歴の段の名前(`ResolvedSolidStep.name`)。段が見つからない id は `null` にして
 *   そのまま渡す——鍵が引けないことは model の橋が断る(同じ判断を 2 か所でしない)。
 * - 色は立体ごと(`bodyColorsFor`)と面ごと(`faceColorsFor`)の**別々の表**から組む。
 *   面の割り当ては立体の色より優先するので、両方をそのまま渡して優先はカーネルに任せる。
 * - **「色を含める」が切れているときは、色そのものを渡さない。** 形式ごとに「色を書くか」の
 *   欄を持つのは STEP だけで、ほかの形式では値を空にするのが色を落とす唯一の手立てである
 *   (§0.a-0.22)。STL は色の欄を初めから見ないので、ここで形式ごとに分けない
 *   (`carriesColor` の表を 2 か所に持たないため)。
 */
export function exportBodiesFor(
  snapshot: PartExchangeSnapshot,
  steps: readonly ResolvedSolidStep[],
  featureIds: readonly string[],
  withColors: boolean,
): readonly ShapeExportBody[] {
  const names = new Map(steps.map((step) => [step.featureId, step.name]));
  const bodyColors = withColors ? bodyColorsFor(snapshot.document, featureIds) : null;
  const faceColors = withColors
    ? faceColorsFor(snapshot.document, featureIds, snapshot.appearanceMatches)
    : null;
  return featureIds.map((featureId) => {
    const color = bodyColors?.get(featureId);
    const faces = faceColors?.get(featureId);
    const body: ShapeExportBody = {
      featureId,
      name: names.get(featureId) ?? null,
      color: color === undefined ? null : rgbTupleOf(color),
    };
    // 色を付けた面が 1 枚も無い立体には面の表を添えない(空の表を作らない、§2.5.1)。
    return faces === undefined ? body : { ...body, faceColors: toFaceColorTuples(faces) };
  });
}

/**
 * 書き出しの結果を、手続き(`exchangeFile.ts`)が受け取る形へ直す。
 *
 * **3MF だけファイルが返らない**(§0.a-0.19。ZIP と XML は `packages/io` が組む)ので、
 * 三角形を `meshes` に載せて `files` は空にする。断りは**日本語の理由の例外**で投げる
 * (`ExchangeKernel` の約束。呼び出し側は帯へそのまま出す)。
 */
export function toExchangeExportOutcome(outcome: ShapeExportOutcome): ExchangeExportOutcome {
  switch (outcome.kind) {
    case 'files':
      return { files: outcome.files, droppedTriangleCount: outcome.droppedTriangleCount };
    case 'meshes':
      // 三角形は落としていないので 0(落とす判定はファイルを書く段にある)。
      return { files: [], droppedTriangleCount: 0, meshes: outcome.bodies };
    case 'failed':
      throw new Error(outcome.message);
  }
}

/** 読み込んだ立体 1 つを、手続きが受け取る形へ直す(B-rep の枝と三角形の枝を保つ)。 */
export function toExchangeImportedBody(body: ImportedBody): ExchangeImportedBody {
  if (body.bodyKind === 'mesh') {
    return {
      bodyKind: 'mesh',
      name: body.name,
      volume: body.volume,
      triangleCount: body.triangleCount,
      mesh: body.mesh,
    };
  }
  return {
    bodyKind: body.bodyKind,
    name: body.name,
    volume: body.volume,
    triangleCount: body.triangleCount,
    brepBytes: body.brepBytes,
  };
}

/**
 * 書き出し・読み込みの口を組み立てる(タスク32b)。
 *
 * `attachExchangeKernel` へ渡すと、ツールバーの「書き出す」「読み込む」が実際に動く
 * (差し出す前は `EXCHANGE_KERNEL_MISSING_MESSAGE` で断られる)。
 */
export function createPartExchanger(deps: PartExchangerDeps): ExchangeKernel {
  return {
    async exportShapes(request: ExchangeExportRequest): Promise<ExchangeExportOutcome> {
      const snapshot = deps.snapshot();
      // 書き出しは再計算を起こさない読み取り(§0.a-0.30)。解くだけで鍵が揃う。
      const steps = resolveCachedSteps(snapshot.document, deps);
      const outcome = await deps.exportShapes(steps, {
        format: request.format,
        bodies: exportBodiesFor(snapshot, steps, request.featureIds, request.withColors),
        meshQuality: request.meshQuality,
        withColors: request.withColors,
        ascii: request.ascii,
        baseName: request.baseName,
      });
      return toExchangeExportOutcome(outcome);
    },

    async importShape(format, fileName, bytes): Promise<ExchangeImportOutcome> {
      const outcome = await deps.importShape({ format, fileName, bytes });
      if (outcome.kind === 'failed') {
        // 読めなかった理由は下の層(幾何カーネル)が日本語で持っている(§2.8)。
        throw new Error(outcome.message);
      }
      return {
        bodies: outcome.bodies.map((body) => toExchangeImportedBody(body)),
        unit: outcome.unit,
      };
    },
  };
}
