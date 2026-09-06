/**
 * 読み込んだ形のベースボディ(FR-802)が**部品文書の経路**
 * (`recomputePart` → `resolvePart` → `kernelBridge` → 実 OCCT)で形に戻ることを、
 * 実物の幾何カーネルで体積まで確かめる(計画書 docs/plans/P6-入出力.md §2.8、
 * §0.a-0.9、P6 タスク20)。
 *
 * ## なぜ純関数の検査(resolvePart.test.ts・kernelApi.test.ts)では足りないか
 *
 * `thruSectionsKernel.test.ts` の冒頭と同じ理由。model 側の単体検査がすべて緑でも、
 * 部品文書の経路で配線が抜けている(バイト列が段まで届かない・鍵が食い違う)ことが
 * 実機で初めて見つかる。読み込んだ形は
 *   ①`.pcad` に抱き込んだバイト列の置き場(`ResolvePartOptions.importedShapes`)→
 *   ②`resolvePart` が `shapeRef` で引いて段へ載せる →
 *   ③`kernelBridge` が `ImportedSolidStepSpec` へ詰め替える →
 *   ④カーネルが `BinTools` で B-rep を戻す
 * の 4 段を通るので、どこか 1 つで落ちても純関数の検査は緑のまま通ってしまう。
 *
 * Worker を使わない理由・OCCT の待ち時間は `thruSectionsKernel.test.ts` と同じ。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi, type KernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type KernelBridge } from '../kernelBridge.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { createOffsetCache } from '../sketch/offsetMath.js';
import { createProjectionCache } from '../sketch/projectionMath.js';
import { appendSolid, createEmptyPartDocument } from './createPartDocument.js';
import { recomputePart } from './recomputePart.js';
import { resolvePart, type ImportedShapeBytes } from './resolvePart.js';
import { createSubShapeCache } from './subShapeCache.js';
import type { ImportedSolidFeature, PartDocument, PrimitiveFeature } from './types.js';

/** OCCT の初期化を含むので、この検査だけ待ち時間を長く取る(kernel の検査と同じ値)。 */
const OCCT_TIMEOUT_MS = 180_000;

/**
 * 20 × 30 × 20 の箱の体積(mm³)。`20 * 30 * 20 = 12000`。
 * 箱を選んだのは、体積が寸法の掛け算だけで決まり、STEP と B-rep の往復で
 * 1 mm³ も変わらないはずの値だからである(近似の入る余地が無い)。
 */
const BOX_VOLUME_MM3 = 12000;

let api: KernelApi;
let bridge: KernelBridge;

beforeAll(async () => {
  await loadOcctForNode();
  api = createKernelApi(loadOcctForNode);
  bridge = createDirectKernelBridge(api);
}, OCCT_TIMEOUT_MS);

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}`);
  }
  return result.value;
}

function caches(): Parameters<typeof recomputePart>[2] {
  return {
    offsets: createOffsetCache(),
    projections: createProjectionCache(),
    subShapes: createSubShapeCache(),
  };
}

/** 20 × 30 × 20 の箱。基準点は原点、向きは既定のワールド Z。 */
function boxFeature(): PrimitiveFeature {
  return {
    id: 'box-1',
    name: '箱1',
    suppressed: false,
    kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: expr('20'), sizeY: expr('30'), sizeZ: expr('20') },
  };
}

function importedSolidFeature(shapeRef: string): ImportedSolidFeature {
  return {
    id: 'importedSolid-1',
    name: '読み込んだ形1',
    suppressed: false,
    kind: 'importedSolid',
    shapeRef,
    source: {
      format: 'step',
      fileName: 'box.step',
      unit: 'mm',
      byteLength: 0,
      importedAt: '2026-09-06T00:00:00.000Z',
    },
    bodyKind: 'solid',
  };
}

function documentWithImportedSolid(shapeRef: string): PartDocument {
  return appendSolid(createEmptyPartDocument(), importedSolidFeature(shapeRef));
}

describe('読み込んだ形のベースボディ(FR-802、P6 §2.8)を実カーネルで往復させる', () => {
  it(
    '箱を STEP へ書き出して読み直し、抱き込んだバイト列から段を作ると体積 12000 に戻る',
    async () => {
      // ① 部品文書で箱を作る(ここまでは P5 からの経路そのまま)。
      const source = appendSolid(createEmptyPartDocument(), boxFeature());
      const built = await recomputePart(source, bridge, caches());
      expect(built.errors).toEqual([]);
      expect(built.bodies).toHaveLength(1);
      expect(built.bodies[0].volume).toBeCloseTo(BOX_VOLUME_MM3, 6);

      // ② その形を STEP のバイト列にする(FR-803。書き出しの口はタスク10 が作った)。
      // 書き出しは**段のキャッシュの鍵**で形を指すので、同じ文書を解決して鍵を取る。
      const sourceKey = resolvePart(source).steps[0].key;
      const exported = await api.exportShapes({
        format: 'step',
        bodies: [{ bodyKey: sourceKey, name: null, color: null }],
      });
      expect(exported.format).toBe('step');
      if (exported.format !== 'step') {
        return;
      }

      // ③ STEP を読み直す(FR-802)。`.pcad` へ抱き込むのは `brepBytes` のほう。
      const read = await api.importShape({ format: 'step', bytes: exported.bytes });
      expect(read.bodies).toHaveLength(1);
      expect(read.unit).toBe('mm');
      const readBody = read.bodies[0];
      expect(readBody.volume).toBeCloseTo(BOX_VOLUME_MM3, 6);
      // STEP は B-rep で入るので、`ShapeImportBody` の「B-rep を持つ枝」になる(P6 タスク16
      // で、三角形しか持たない STL / OBJ / glTF 用の枝と型で分けた)。
      expect(readBody.bodyKind).toBe('solid');
      if (readBody.bodyKind === 'mesh') {
        return;
      }
      expect(readBody.brepBytes.byteLength).toBeGreaterThan(0);

      // ④ 抱き込んだバイト列の置き場を作り、読み込んだ形だけの部品文書を再計算する。
      const importedShapes: ImportedShapeBytes = new Map([['shape-1', readBody.brepBytes]]);
      const document = documentWithImportedSolid('shape-1');
      const restored = await recomputePart(document, bridge, {
        ...caches(),
        importedShapes,
      });
      expect(restored.errors).toEqual([]);
      expect(restored.bodies).toHaveLength(1);
      expect(restored.bodies[0].featureId).toBe('importedSolid-1');
      expect(restored.bodies[0].volume).toBeCloseTo(BOX_VOLUME_MM3, 6);
      // 箱なので面は 6 枚のまま(往復で形が崩れていないことの裏取り)。
      expect(restored.bodies[0].faces).toHaveLength(6);

      // ⑤ 鍵は `shapeRef` だけなので、2 回目は必ず形状キャッシュに当たる(NFR-PF-3)。
      const again = await recomputePart(document, bridge, {
        ...caches(),
        importedShapes,
        generation: 1,
      });
      expect(again.cacheHits).toBe(1);
      expect(again.bodies[0].volume).toBeCloseTo(BOX_VOLUME_MM3, 6);
    },
    OCCT_TIMEOUT_MS,
  );

  /**
   * 上の検査は `KernelApi` を直に呼んでいる(タスク20 の時点では橋に口が無かった)。
   * ここでは**橋の口**(`KernelBridge.exportShapes` / `importShape`、P6 タスク32b)を通す。
   *
   * 橋を通すと、段の鍵への引き直し(`featureId` → `ResolvedSolidStep.key`)と、
   * STEP のファイル名の組み立て、結果の詰め替えという**ui が頼る 3 つの配線**が一緒に通る。
   * 偽の `KernelApi` ではこの 3 つが揃っていても形になるかは分からない(t21 の教訓)。
   */
  it(
    '橋の口で箱を STEP へ書き出し、同じ橋で読み戻すと体積が変わらない',
    async () => {
      const source = appendSolid(createEmptyPartDocument(), boxFeature());
      const built = await recomputePart(source, bridge, caches());
      expect(built.errors).toEqual([]);
      expect(built.bodies[0].volume).toBeCloseTo(BOX_VOLUME_MM3, 6);

      // 書き出しは段の鍵で形を指すが、**呼び出し側はフィーチャーの id しか渡さない**。
      const exported = await bridge.exportShapes(resolvePart(source).steps, {
        format: 'step',
        bodies: [{ featureId: 'box-1', name: '箱1', color: [1, 0, 0] }],
        meshQuality: null,
        withColors: true,
        ascii: false,
        baseName: 'box',
      });
      expect(exported.kind).toBe('files');
      if (exported.kind !== 'files') {
        return;
      }
      // 名前は橋が組む(`.obj` と `.mtl` の対と同じ約束で、呼び出し側は数えずに保存する)。
      expect(exported.files).toHaveLength(1);
      expect(exported.files[0].fileName).toBe('box.step');
      // STEP(ISO 10303-21)の先頭の合図。中身が本当に STEP であることの裏取り。
      expect(new TextDecoder().decode(exported.files[0].bytes.slice(0, 12))).toBe('ISO-10303-21');

      const imported = await bridge.importShape({
        format: 'step',
        fileName: 'box.step',
        bytes: exported.files[0].bytes,
      });
      expect(imported.kind).toBe('imported');
      if (imported.kind !== 'imported') {
        return;
      }
      // STEP は単位を持つので、利用者へ訊かずに mm と分かる(§0.a-0.6)。
      expect(imported.unit).toBe('mm');
      expect(imported.bodies).toHaveLength(1);
      const body = imported.bodies[0];
      expect(body.bodyKind).toBe('solid');
      expect(body.volume).toBeCloseTo(BOX_VOLUME_MM3, 6);
      if (body.bodyKind === 'mesh') {
        return;
      }
      // 読み戻した B-rep はそのまま `.pcad` の `shapes/<id>.brep` へ入る(タスク20 の経路)。
      expect(body.brepBytes.byteLength).toBeGreaterThan(0);
    },
    OCCT_TIMEOUT_MS,
  );

  /**
   * 3D プリントの点検(FR-815、P6 タスク46)の橋の口(`KernelBridge.inspectPrintability`)を
   * 実カーネルで 1 往復させる。**偽の `KernelApi` では確かめられない 3 つ**——
   * ①フィーチャーの id から段の鍵への引き直し、②細かさの対の詰め替え、③三角形ごとの
   * 真偽と要約の詰め替え——が一緒に通る(書き出しの往復と同じ理由、t21 の教訓)。
   *
   * 期待値は §2.16 の表の 1 行目(20³ の箱)を、この検査の箱(20 × 30 × 20)に読み替えたもの。
   * 最小肉厚は最も短い辺(20)、開いた辺は 0 本、せり出しは 0 枚(底面は造形台に接するので除く)。
   */
  it(
    '橋の口で箱を点検すると、閉じていて・せり出し 0 枚・最小肉厚が最も短い辺になる',
    async () => {
      const source = appendSolid(createEmptyPartDocument(), boxFeature());
      const built = await recomputePart(source, bridge, caches());
      expect(built.errors).toEqual([]);

      const outcome = await bridge.inspectPrintability(resolvePart(source).steps, {
        bodies: ['box-1'],
      });
      expect(outcome.kind).toBe('inspected');
      if (outcome.kind !== 'inspected') {
        return;
      }
      const { summary } = outcome.report;
      // 箱は面 6 枚 × 三角形 2 枚。細かさを変えても平面は割れないので 12 枚で決まる。
      expect(outcome.report.triangleCount).toBe(12);
      expect(summary.watertight).toBe(true);
      expect(summary.openEdgeCount).toBe(0);
      // 底面は造形台に接するので支持が要らない。側面は水平から 90° 立っている。
      expect(summary.overhangCount).toBe(0);
      // 20mm の壁は既定のしきい値(0.8mm)よりずっと厚い。
      expect(summary.thinCount).toBe(0);
      expect(summary.minThicknessFoundMm).toBeCloseTo(20, 6);
      // しきい値は省いたのでカーネルの既定がそのまま返る(画面はこの値を表示する)。
      expect(summary.minThicknessMm).toBe(0.8);
      expect(summary.overhangAngleDeg).toBe(45);
      expect(outcome.report.cancelled).toBe(false);
    },
    OCCT_TIMEOUT_MS,
  );

  it(
    '段の鍵が引けない立体を頼むと、カーネルを呼ばずに断る',
    async () => {
      const source = appendSolid(createEmptyPartDocument(), boxFeature());
      await recomputePart(source, bridge, caches());

      // 文書に無い id。鍵へ引き直せないので、点検そのものを行わずに断る(§0.a-0.30)。
      const outcome = await bridge.inspectPrintability(resolvePart(source).steps, {
        bodies: ['box-1', 'box-2'],
      });
      expect(outcome.kind).toBe('failed');

      // 立体を 1 つも指さないときも Worker を起こさない。
      const empty = await bridge.inspectPrintability(resolvePart(source).steps, { bodies: [] });
      expect(empty.kind).toBe('failed');
    },
    OCCT_TIMEOUT_MS,
  );
});
