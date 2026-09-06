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
});
