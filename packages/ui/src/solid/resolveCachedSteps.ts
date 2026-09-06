/**
 * 覚え書きだけで部品文書を段の一覧へ解く(計画書 docs/plans/P5-高度なソリッド・外観と測定.md
 * §0.a-0.30、docs/plans/P6-入出力.md §2.4、P5 タスク32・P6 タスク32b)。
 *
 * 対応要件: FR-207(パラメータ表)、FR-803(書き出し)、FR-1101・FR-1102(測定)、NFR-PF-2。
 *
 * **カーネルを 1 度も呼ばない。** 測定も書き出しも「覚えてある形を読むだけ」の操作
 * (§0.a-0.30)で、ここから再計算を起こさない。だが幾何カーネルは**段の鍵**
 * (`ResolvedSolidStep.key`)でしか形を引けないので、読む前に文書を解き直して鍵を作る。
 *
 * 形の材料(オフセット・投影・部分形状の選び直し)は再計算が貯めた覚え書きから引く
 * (`recomputePart` が `resolveOptions` を組み立てるのとまったく同じ引き方)。覚え書きに
 * 無いものがあれば鍵が食い違い、カーネルは「見つからない」を返す(落とさない、NFR-RE-1)。
 *
 * **測定と書き出しで同じ解き方を 2 か所に書かない。** 片方だけ直すと、同じ文書から
 * 測れるのに書き出せない(またはその逆)という食い違いが起きる。
 */

import {
  applyParameters,
  resolvePart,
  type ImportedShapeBytes,
  type OffsetCache,
  type PartDocument,
  type ProjectionCache,
  type ResolvedCurve,
  type ResolvedSolidStep,
  type ResolvePartOptions,
  type SubShapeCache,
} from '@pointercad/model';

/** 解くのに要る覚え書き。再計算が使っているものと**同じ 3 つ**を渡す(NFR-PF-2)。 */
export interface CachedResolveDeps {
  readonly offsets: OffsetCache;
  readonly projections: ProjectionCache;
  readonly subShapes: SubShapeCache;
  /**
   * 読み込んだ形の B-rep のバイト列(FR-802、P6 §2.8、タスク20)。
   *
   * **渡さないと `importedSolid` の段が作れず、その立体は測れも書き出せもしない**
   * (「もとになる立体が見つかりませんでした」になる。2026-09-06 のヘッドレスで実測)。
   * 再計算(`attachPartRecompute`)がストアの表をそのまま渡しているのと同じ表を、
   * ここでも**呼ばれるたびに**読む(読み込みのたびに増えるため)。
   */
  readonly importedShapes?: () => ImportedShapeBytes;
}

/**
 * 文書を段の一覧へ解く。**パラメータ表(FR-207)を式へ配ってから解く**のも
 * `recomputePart` と同じで、ここを通さないと名前を付けた数値を使った部品で段の鍵が変わる。
 */
export function resolveCachedSteps(
  document: PartDocument,
  deps: CachedResolveDeps,
): readonly ResolvedSolidStep[] {
  const evaluated = applyParameters(document).document;
  /** この解決の中で埋まった投影・交差の曲線(`recomputePart` の同名の表と同じ役目)。 */
  const projected = new Map<string, readonly ResolvedCurve[]>();
  const options: ResolvePartOptions = {
    offsetCurves: (key) => deps.offsets.get(key),
    projectedCurves: (featureId) => projected.get(featureId) ?? null,
    subShape: (reference) => deps.subShapes.resolve(reference),
    importedShapes: deps.importedShapes?.(),
  };
  const first = resolvePart(evaluated, options);
  if (first.projections.length === 0) {
    return first.steps;
  }
  let filled = false;
  for (const request of first.projections) {
    const remembered = deps.projections.get(request.key);
    if (remembered !== null) {
      projected.set(request.featureId, remembered);
      filled = true;
    }
  }
  // 投影の曲線が入ったので解き直す(`resolveWithOffsets` の 2 巡目と同じ)。
  return filled ? resolvePart(evaluated, options).steps : first.steps;
}
