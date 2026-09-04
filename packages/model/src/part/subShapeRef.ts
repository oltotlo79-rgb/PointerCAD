/**
 * 部分形状(面・辺・頂点)への参照の道具(種類の判定・同一判定・重複除去・鍵の材料への
 * 文字列化)。
 *
 * P4(docs/plans/P4-スケッチ拡張.md §0.a-0.7、§2.6、タスク3)で実体を
 * `geometry/subShapeRef.ts`(`part` にも `sketch` にも依存しない中立の置き場)へ移した。
 * `resolvePart.ts` 等の既存コードの import 文 `from './subShapeRef.js'` を変えずに済ませる
 * ため、このファイルは re-export だけを残す(ファイル自体は削除しない)。
 */
export {
  dedupeSubShapeRefs,
  fingerprintKeyText,
  isSameSubShape,
  subShapeKindOf,
} from '../geometry/subShapeRef.js';
