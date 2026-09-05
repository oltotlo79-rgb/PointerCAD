import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from '../occt/allocations.js';
import { booleanOp, type BooleanResult } from '../occt/booleanOp.js';
import type { OcctShapeHandle } from '../occt/makeBox.js';
import { makeChamfer } from '../occt/makeChamfer.js';
import { makeCut } from '../occt/makeCut.js';
import { makeDraft } from '../occt/makeDraft.js';
import { makeEmboss } from '../occt/makeEmboss.js';
import { makeFillet } from '../occt/makeFillet.js';
import { makeHole } from '../occt/makeHole.js';
import { makePrimitive, resolvePrimitiveOrigin } from '../occt/makePrimitive.js';
import { makeRib } from '../occt/makeRib.js';
import { makeShell } from '../occt/makeShell.js';
import { makeExtrudeSolid, makeRevolveSolid } from '../occt/makeSolidSweep.js';
import { makeSpring } from '../occt/makeSpring.js';
import type { SurfaceResult } from '../occt/makeSurface.js';
import { makeSurface } from '../occt/makeSurface.js';
import { makeSweep } from '../occt/makeSweep.js';
import { makeThinExtrude } from '../occt/makeThinExtrude.js';
import { makeThreadHole, makeThreadShaft } from '../occt/makeThread.js';
import { makeThruSections, sectionWireFromFace } from '../occt/makeThruSections.js';
import { makeVariableFillet } from '../occt/makeVariableFillet.js';
import { matchFace } from '../occt/matchSubShape.js';
import { sewSolid } from '../occt/sewSolid.js';
import { mirrorShape, scaleShape, transformShape } from '../occt/transformShape.js';
import { buildSolidBodyMesh, measureArea } from '../occt/solidMesh.js';
import { boundingDiagonal } from '../occt/subShapes.js';
import type {
  AppearanceMatch,
  AppearanceQuery,
  BooleanStepSpec,
  ExtrudeStepSpec,
  FilletStepSpec,
  PrimitiveStepSpec,
  SolidBodyMesh,
  SolidFaceInfo,
  SolidProgress,
  SolidRecomputeRequest,
  SolidRecomputeResult,
  SolidStepFailure,
  SolidStepRequest,
  SolidStepSpec,
  SubShapeQuery,
  SurfaceStepSpec,
  TessellationOptions,
  ThreadMarkInfo,
  ThruSectionsStepSpec,
} from '../types.js';
import type { ShapeCache } from './shapeCache.js';

/**
 * 掃引体(ばね・実らせん)専用の粗いテッセレーション許容値(P3 仕上げ、2026-09-04)。
 *
 * **背景.** 既定(線形 0.1mm・角度 0.5rad)は φ6 の穴のような小さい円柱面を
 * 「1 周 24 分割以上」に保つぎりぎりの値で(2026-09-04 実測: 半径 3mm の円柱面で
 * 26 分割)、これ以上緩めると穴が角張って見える。**一方で掃引体(ばね・実らせんの溝)は
 * 円柱ではなく B スプライン曲面で近似されるため、同じ許容値でも桁違いに多くの
 * 三角形を要る**(2026-09-04 実測: ばね D20/d2/p5/n4 で三角形 10114 枚・
 * tessellate 380〜900ms。穴 20 個の板全体でも三角形 2172 枚しか無いのと対照的)。
 *
 * **選定根拠(一時的な検査ファイルで実測、検査は削除済み)。**
 * 線形 0.15mm・角度 0.7rad を境に、ばねの三角形数がなだらかに下がる領域(線形
 * 0.13〜0.16mm・角度 0.65〜0.75rad)を見つけた。この領域の外側(0.12 以下・0.18 以上)
 * では逆に増えることがある(BRepMesh が B スプライン曲面を分割する内部の閾値に
 * よる非単調な挙動。2026-09-04 実測)ため、領域の中央である 0.15 / 0.7 を採る。
 *
 * | 形状 | 既定(0.1/0.5) | 0.15/0.7 | 三角形の増減 |
 * |---|---|---|---|
 * | ばね D20/d2/p5/n4 | 10114 枚・380〜900ms | 2066 枚・108〜137ms | -80% |
 * | ばね D10/d1/p2/n4(細い) | 5736 枚 | 3568 枚 | -38% |
 * | ばね D30/d4/p8/n4(太い) | 8198 枚 | 4792 枚 | -42% |
 * | ばね D20/d2/p5/n20(巻数20) | 24262 枚 | 11130 枚 | -54% |
 * | 実らせん M6×1・10巻きの溝 | 1998 枚・93ms | 1506 枚・72ms | -25% |
 *
 * **見た目の確認(0.15/0.7 で線材の断面が何分割になるか、頂点の角度から実測)。**
 * 線径 1mm(半径 0.5mm、最小クラス)でも 18 分割、線径 2mm(半径 1mm)で 18 分割。
 * どちらも要件の下限「8 分割以上」に十分な余裕がある。すべての試したばねの寸法
 * (細い・太い・巻数多い)で既定より必ず速くなり(最悪でも -25%)、悪化した例は無い。
 *
 * **穴には適用しない.** 穴・面取り・押し出し等は既定のまま(このファイルの
 * `isRelaxableSweepStep` が対象を絞る)。穴 20 個の所要(実測 485〜510ms)は
 * ほぼ全て `makeHole` 自身(ブーリアン)が占め、テッセレーションは 1〜2 割
 * (実測 111〜210ms のうち tessellate は 111〜156ms)に過ぎないうえ、
 * 上で書いたとおり緩める余地が無い(24 分割の下限にすでに近い)。
 */
const SWEEP_LINEAR_DEFLECTION = 0.15;
const SWEEP_ANGULAR_DEFLECTION = 0.7;

/** 上の注釈の許容値をまとめた 1 個。 */
const SWEEP_TESSELLATION_OPTIONS: TessellationOptions = {
  linearDeflection: SWEEP_LINEAR_DEFLECTION,
  angularDeflection: SWEEP_ANGULAR_DEFLECTION,
};

/**
 * 粗いテッセレーションを当ててよい段か。
 *
 * ばね(FR-414)は必ず対象。ねじ穴(FR-406)は**実らせんを切ったとき**だけ対象にする
 * (`thread !== null`)。簡略表示(`thread === null`)は下穴の円柱面だけなので、
 * 穴と同じ理由で既定のまま(緩めると円柱面が角張る)。
 *
 * **基本形状(FR-429)は対象にしない**(P5 タスク14 の判断、2026-09-05 実測)。
 * 球とトーラスは面 1 枚の曲面なので三角形が増えることを心配したが、既定
 * (線形 0.1mm・角度 0.5rad)での実測は下表のとおりで、掃引体のような桁違いの
 * 増え方はしなかった(ばねは既定で 10114 枚・380〜900ms)。
 *
 * | 形(既定の寸法) | 既定 0.1/0.5 | 掃引体 0.15/0.7 | 角度だけ 0.8 |
 * |---|---|---|---|
 * | 球 r=10 | 978 枚・47.6ms | 638 枚・19.9ms | 978 枚・28.6ms |
 * | トーラス R=20 r=5 | 2600 枚・56.4ms | 1558 枚・31.7ms | 2300 枚・47.4ms |
 * | 円柱 r=10 h=20 | 124 枚・6.7ms | 100 枚・4.5ms | 124 枚・5.3ms |
 * | 円錐 R=10 h=20 | 385 枚・14.4ms | 279 枚・7.3ms | 385 枚・11.1ms |
 * | 箱 20³ | 12 枚・4.4ms | 12 枚・5.0ms | 12 枚・4.2ms |
 *
 * 緩める目安(球 r=10 で三角形 2000 枚超、または 100ms 超)に**どれも届かない**ので、
 * 見た目を落としてまで緩める理由が無い。**計画書 §2.13 が案として書いた
 * 「基本形状だけ `angularDeflection: 0.8`」は、この寸法では効かない**(球で 978 → 978 枚、
 * トーラスで 2600 → 2300 枚)。これらの大きさでは角度ではなく線形の許容値のほうが
 * 細かさを決めているためで、角度だけを緩めても三角形はほとんど減らない。
 *
 * 大きな球(r=100 で 10108 枚・272ms)は既定でも重いが、NFR-PF-2 の上限 500ms には
 * 収まっている。必要になれば段ごとの指定(`SolidStepRequest.tessellation`)で
 * 寸法に応じて緩められるので、ここに寸法の分岐を作らない。
 *
 * **P5 タスク42a で 2 種を足した。** どちらも上の表の「掃引体」そのもので、
 * B スプライン曲面が出る作り方だから同じ扱いにする:
 * - **スイープ(FR-409)** は `BRepOffsetAPI_MakePipeShell`(ばねと同じ道具)。
 * - **外ねじ(FR-423)** は**実らせんを切ったとき**(`modeled`)だけ。簡略表示は
 *   B-rep に触れず対象の形をそのまま返すので、対象の粗さを変えてはいけない
 *   (ねじ穴の `thread === null` と同じ理由)。
 *
 * **曲面(FR-428)・切断・抜き勾配などは対象にしない。** 平面と円柱面が主で、
 * 穴と同じ理由(24 分割の下限に近い)で緩める余地が無い。
 */
function isRelaxableSweepStep(step: SolidStepSpec): boolean {
  if (step.kind === 'spring' || step.kind === 'sweep') {
    return true;
  }
  if (step.kind === 'threadShaft') {
    return step.modeled;
  }
  return step.kind === 'thread' && step.thread !== null;
}

/** 許容値が 1 つでも指定されているか(空なら「既定のまま」を意味する)。 */
function hasDeflection(options: TessellationOptions | undefined): options is TessellationOptions {
  return (
    options !== undefined &&
    (options.linearDeflection !== undefined || options.angularDeflection !== undefined)
  );
}

/**
 * 段の種類に応じてテッセレーション許容値を選ぶ(§0.35「形に応じて緩める」)。
 *
 * 優先順位は **① 段ごとの指定(`SolidStepRequest.tessellation`、P5 §2.13)→
 * ② 呼び出し側が渡した全体の指定 → ③ 段の種類ごとの既定**(掃引体だけ粗くする)。
 *
 * **呼び出し側が明示的に許容値を指定しているときは、その指定を必ず尊重する.**
 * 掃引体だからと言って上書きすると、呼び出し側の意図(検査で細かい値を敢えて
 * 指定した場合など)を壊すため、①②のどちらも空のときだけ③で選び直す。
 */
function resolveTessellationOptions(
  options: TessellationOptions,
  request: SolidStepRequest,
): TessellationOptions {
  if (hasDeflection(request.tessellation)) {
    return request.tessellation;
  }
  if (hasDeflection(options)) {
    return options;
  }
  return isRelaxableSweepStep(request.step) ? SWEEP_TESSELLATION_OPTIONS : options;
}

/**
 * キャッシュに命中した段のメッシュへ、必要なら表面積を後から足す(統括の決定 2026-09-05)。
 *
 * 表面積は依頼が `measureAreas` で求めたときだけ測る(`SolidRecomputeRequest` の注釈)。
 * そのため、先の再計算が求めなかった依頼だと、覚えてあるメッシュに `area` が入っていない。
 * ここでその場で測って足す。**形はキャッシュが持っているので段を作り直さない**ので、
 * 費用は表面積の測定 1 回ぶん(面 26 枚の板で 11.4ms)だけで済む。
 */
function withMeasuredArea(
  oc: OpenCascadeInstance,
  mesh: SolidBodyMesh,
  shape: TopoDS_Shape,
  wanted: boolean,
): SolidBodyMesh {
  if (!wanted || mesh.area !== undefined) {
    return mesh;
  }
  return { ...mesh, area: measureArea(oc, shape) };
}

/**
 * キャッシュに預ける 1 件。形と、その形から作った表示用データを組にして持つ。
 *
 * メッシュも一緒に覚えるのは、鍵が当たったときに三角形分割と体積計算まで
 * やり直さずに済ませるため(NFR-PF-3。当たった段は OCCT を一切呼ばない)。
 * `mesh` には面・辺・頂点の一覧(§2.2 の指紋の材料)も入っているので、
 * 加工の段(穴・ねじ穴・R 面取り・C 面取り)が上流を入力にするときも
 * 一覧を作り直さない(タスク10、計画書 §2.8 の「一覧を作り直さない」)。
 * delete() は形と、形を作るために確保した領域(maker 等)の両方を手放す
 * (makeBox.ts の OcctShapeHandle と同じ約束)。
 */
export interface CachedSolid {
  readonly shape: TopoDS_Shape;
  readonly mesh: SolidBodyMesh;
  delete(): void;
}

/**
 * 再計算に要るもの。Worker の中で 1 組だけ作って使い回す。
 *
 * キャッシュを外から渡す形にしてあるのは、検査でキャッシュの当たり外れと
 * 作り直した回数を直に観測できるようにするため(計画書 タスク7 の手順1)。
 */
export interface SolidRecomputeDeps {
  readonly oc: OpenCascadeInstance;
  readonly cache: ShapeCache<CachedSolid>;
}

/** 段を始める前に 1 回ずつ呼ばれる。Comlink 越しでは Comlink.proxy した関数が入る。 */
export type SolidProgressCallback = (progress: SolidProgress) => void;

/**
 * 中止を尋ねる口。true を返すと、残りの段を計算せずに打ち切る。
 *
 * Comlink 越しの呼び出しは必ず Promise を返すので、真偽値と Promise の
 * どちらも受け取れる形にしてある(呼ぶ側は await する)。
 */
export type SolidCancelToken = () => boolean | Promise<boolean>;

/** ブーリアンの相手がキャッシュにも失敗の記録にも無いとき(FR-504、NFR-RE-1)。 */
const MISSING_INPUT_MESSAGE = 'もとになる立体が見つかりませんでした。';

/** ブーリアンの相手が、同じ再計算の中で作れなかった段だったとき(FR-504)。 */
function upstreamFailedMessage(label: string): string {
  return `もとになる立体「${label}」を作れなかったため、この立体も作れませんでした。`;
}

/**
 * 例外から、利用者へそのまま見せる日本語を取り出す(§0.a-0.19、タスク10)。
 *
 * 各 make*.ts(makeHole・makeThread・makeFillet・makeChamfer・makeSpring)は、
 * OCCT の C++ 側が投げる例外(embind を通ると実体へのポインタを指す**数値**として
 * 飛んでくる。makeFillet.ts / makeChamfer.ts の 2026-09-03 実測)をすでに
 * 日本語の Error へ包んで投げ直している。この関数はその最後の網で、
 * 万一 Error でない値(数値・undefined 等)がそのまま飛んできても、
 * 画面に数字や `[object Object]` を出さない(NFR-RE-1「止めずに理由を出す」)。
 */
function toFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return '幾何カーネルの内部で失敗しました。値を見直して、もう一度お試しください。';
}

/**
 * 段と段の間で 1 回だけ制御を譲る(§2.6、§0.a-0.22)。
 *
 * Promise の解決(マイクロタスク)では Worker は受信待ちの通知を処理できないので、
 * setTimeout を挟んでイベントループを 1 周させる。ここで中止の知らせが届く。
 *
 * **限界:** 止まれるのは段と段の間だけで、1 段の OCCT 演算そのものは途中で止められない。
 * 時間のかかるブーリアン 1 回を打ち切ることはできない。
 */
function yieldToMessages(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 段の入力をキャッシュから引く。無ければ理由をつけて断る。
 * 同じ再計算の中で作れなかった段が入力なら、その段の名前を出す(下流も理由つきで失敗させる)。
 *
 * ブーリアン(タスク7 以前)と加工(穴・ねじ穴・R 面取り・C 面取り、タスク10)の両方が使うので、
 * どちらも同じ「もとになる立体が見つかりませんでした。」の文言で断る
 * (計画書 タスク10 の手順2。もとは findBooleanInput という名前だった)。
 */
function findStepInput(
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
  key: string,
): CachedSolid {
  const found = cache.get(key);
  if (found !== undefined) {
    return found;
  }
  const failedLabel = failedLabels.get(key);
  throw new Error(failedLabel === undefined ? MISSING_INPUT_MESSAGE : upstreamFailedMessage(failedLabel));
}

/**
 * 2 つの立体を組み合わせる段。
 * 入力の形はキャッシュの持ち物なので、この段では解放しない(booleanOp も引数に触れない)。
 */
function createBooleanSolid(
  oc: OpenCascadeInstance,
  spec: BooleanStepSpec,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): BooleanResult {
  const target = findStepInput(cache, failedLabels, spec.targetKey);
  const tool = findStepInput(cache, failedLabels, spec.toolKey);
  return booleanOp(oc, spec.operation, target.shape, tool.shape);
}

/**
 * 頂点を基準にする基本形状なのに、頂点を持つ立体の段が指定されていないとき(FR-504)。
 * `originQuery` と `targetKey` は必ず組で来る約束(`PrimitiveStepSpec` の注釈)なので、
 * ここへ来るのは組み立て側の取りこぼしだが、画面を止めずに理由を出す(NFR-RE-1)。
 */
const MISSING_PRIMITIVE_TARGET_MESSAGE =
  '中心にする頂点を持つ立体が見つかりません。頂点を選び直してください。';

/**
 * 基本形状の段(FR-429)。ふつうは中心・向き・寸法だけで決まるので上流の形を見ない。
 *
 * **`originQuery` があるときだけ、`targetKey` の形から頂点を引いて基準点にする**
 * (§0.a-0.18、P5 タスク14b)。そのとき `origin` は「頂点からのオフセット」になるので、
 * 頂点の座標へ足してから `makePrimitive` へ渡す。
 *
 * **対象は消費しない。** 穴・ねじ穴・面取り・ブーリアンの `targetKey` は対象を食べるが、
 * ここは頂点の座標を読むだけなので、対象のボディはそのまま画面に残る(結果は 2 ボディ)。
 * 消費の有無を決めているのは段の `visible` で、この関数はそれに一切触れない。
 *
 * 頂点の一覧は `CachedSolid.mesh.vertices`(上流の段が作ったときの一覧)をそのまま使うので、
 * 一覧を作り直さない(NFR-PF-2、§2.8 の「一覧を作り直さない」)。
 */
function createPrimitiveSolid(
  oc: OpenCascadeInstance,
  spec: PrimitiveStepSpec,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): OcctShapeHandle {
  if (spec.originQuery === null) {
    return makePrimitive(oc, spec);
  }
  if (spec.targetKey === null) {
    throw new Error(MISSING_PRIMITIVE_TARGET_MESSAGE);
  }
  const target = findStepInput(cache, failedLabels, spec.targetKey);
  const origin = resolvePrimitiveOrigin(
    oc,
    spec.originQuery,
    spec.origin,
    target.shape,
    target.mesh.vertices,
  );
  // 解決し終えた指紋と鍵は落として渡す。makePrimitive は世界座標だけを見る約束なので、
  // 解決済みであることを型ではなく値で示しておく(二重に解決する余地を残さない)。
  return makePrimitive(oc, { ...spec, origin, originQuery: null, targetKey: null });
}

/**
 * 罫線面(FR-430)・ロフト(FR-410)の段(P5 §2.9、タスク24・24b)。
 *
 * 断面が**立体の面(`faceQuery`)のときだけ**、`targetKey` の形と部分形状の一覧を
 * キャッシュから引いて面を選び直し、その外周を輪郭として取り出す(`sectionWireFromFace`)。
 * 引き方は穴・ねじ穴・面取りとまったく同じ `findStepInput` で、**同じ手順を 2 か所に書かない**。
 * 一覧(`CachedSolid.mesh`)は上流の段が作ったものをそのまま使うので作り直さない(§2.8)。
 *
 * **対象は消費しない**(§0.a-0.27)。輪郭を貸した立体はそのまま画面に残るので、
 * 1 つにまとめたければ利用者が和(FR-404)を取る。消費の有無を決めているのは段の
 * `visible` で、この関数はそれに一切触れない。
 *
 * 取り出した輪郭は出来上がった形と寿命を揃える(結果を手放すときに一緒に手放す)。
 * `makeThruSections` の中で確保したものと同じ扱いにして、解放の責任を 1 か所にまとめる。
 */
function createThruSectionsSolid(
  oc: OpenCascadeInstance,
  spec: ThruSectionsStepSpec,
  options: TessellationOptions,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    const faceWires = new Map<number, TopoDS_Wire>();
    for (let index = 0; index < spec.sections.length; index += 1) {
      const section = spec.sections[index];
      if (section.kind !== 'faceQuery') {
        continue;
      }
      const target = findStepInput(cache, failedLabels, section.targetKey);
      faceWires.set(
        index,
        sectionWireFromFace(oc, target.shape, target.mesh, section.query, keep),
      );
    }
    const handle = makeThruSections(oc, spec, options, faceWires);
    return {
      shape: handle.shape,
      delete(): void {
        try {
          handle.delete();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 「次の面まで」の押し出し(FR-415)なのに、相手の立体の鍵が入っていないとき(FR-504)。
 * `end.kind === 'toNext'` と `targetKey` は必ず組で来る約束(`ExtrudeStepSpec` の注釈)なので、
 * ここへ来るのは組み立て側の取りこぼしだが、画面を止めずに理由を出す(NFR-RE-1)。
 */
const MISSING_EXTRUDE_TARGET_MESSAGE =
  '「次の面まで」の相手になる立体が見つかりません。相手の立体を選び直してください。';

/**
 * 薄板押し出し(FR-416)に、終端の指定やテーパ角が一緒に来たとき(FR-504)。
 *
 * 薄板は輪郭をオフセットして帯を押し出す別の作り方(`occt/makeThinExtrude.ts`)で、
 * 終端(両側・次の面まで)とテーパは受け取れない。**黙って無視すると、利用者が
 * 指定したはずの終端が効かない形が黙ってできる**ので、理由をつけて断る。
 */
const THIN_EXTRUDE_SHAPING_MESSAGE =
  '薄い板の押し出しでは、終端の指定と側面の傾きは使えません。厚みを外すか、指定を外してください。';

/**
 * 押し出しの段(FR-401、FR-415、FR-416)。P2 からの「距離ぶん片側へ」に、
 * P5 で終端・テーパ・薄板が乗った(`ExtrudeStepSpec` の注釈)。
 *
 * 3 通りに分かれる:
 * - **薄板**(`thin`)は `makeThinExtrude`。輪郭をオフセットした帯を押し出す別の作り方。
 * - **「次の面まで」**(`end.kind === 'toNext'`)は相手の形が要るので、`targetKey` の段を
 *   キャッシュから引いて渡す。**相手は消費しない**(材料の位置を読むだけ)。
 * - それ以外は `makeExtrudeSolid` へそのまま渡す。欄をすべて省いた依頼は
 *   P2 からの押し出しと 1 ドットも変わらない。
 */
function createExtrudeSolid(
  oc: OpenCascadeInstance,
  spec: ExtrudeStepSpec,
  options: TessellationOptions,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): OcctShapeHandle {
  if (spec.thin !== undefined) {
    if (spec.end !== undefined || spec.taperAngle !== undefined) {
      throw new Error(THIN_EXTRUDE_SHAPING_MESSAGE);
    }
    return makeThinExtrude(
      oc,
      {
        profile: spec.profile,
        direction: spec.direction,
        distance: spec.distance,
        thickness: spec.thin.thickness,
        side: spec.thin.side,
      },
      options,
    );
  }

  let target: TopoDS_Shape | null = null;
  if (spec.end?.kind === 'toNext') {
    if (spec.targetKey === undefined || spec.targetKey === null) {
      throw new Error(MISSING_EXTRUDE_TARGET_MESSAGE);
    }
    target = findStepInput(cache, failedLabels, spec.targetKey).shape;
  }

  return makeExtrudeSolid(oc, spec, options, {
    end: spec.end,
    taperAngle: spec.taperAngle,
    taperOutward: spec.taperOutward,
    target,
  });
}

/**
 * R 面取りの段(FR-407、FR-426)。半径が数 1 つなら一定半径、始点と終点の 2 つなら可変半径。
 *
 * **振り分けはここ 1 か所だけ**にして、作り手(`makeFillet.ts` / `makeVariableFillet.ts`)は
 * それぞれ 1 種類の半径だけを見る(§0.a-0.48。ファイルは別のまま)。
 * 可変半径は段の中のすべての辺に同じ 2 値を当てる(`FilletRadiusSpec` の注釈)。
 */
function createFilletSolid(
  oc: OpenCascadeInstance,
  spec: FilletStepSpec,
  target: CachedSolid,
): OcctShapeHandle {
  const radius = spec.radius;
  if (typeof radius === 'number') {
    return makeFillet(oc, { ...spec, radius }, target.shape, target.mesh);
  }
  return makeVariableFillet(oc, target.shape, target.mesh, {
    targets: spec.targets.map((subShape) => ({
      target: subShape,
      startRadius: radius.start,
      endRadius: radius.end,
    })),
  });
}

/**
 * 曲面の段(FR-428、§0.a-0.45)。**閉じた立体ではなく面のボディ**を作る。
 *
 * 作り方が「すでにある立体の面を取り出す」(`shape.kind === 'face'`)か「その面を距離だけ
 * 離す」(`shape.kind === 'offset'`)ときだけ、`targetKey` の形と部分形状の一覧を
 * キャッシュから引いて渡す。引き方は穴・面取り・罫線面とまったく同じ `findStepInput` で、
 * **同じ手順を 2 か所に書かない**。**対象は消費しない**(面を貸した立体は画面に残る)。
 *
 * `makeSurface` は「面ができたか」の判定のために面積を必ず 1 回測っており、その値を
 * `SurfaceResult.area` に添えて返す。**その面積をそのまま持ち帰り、`buildSolidBodyMesh` の
 * `knownArea` へ渡して測り直さない**(タスク42b。ブーリアンが体積を添えて返すのと同じ流儀)。
 * 面積を欄に載せるかどうかの判断(`measureAreas`)は変えていない。
 */
function createSurfaceSolid(
  oc: OpenCascadeInstance,
  spec: SurfaceStepSpec,
  options: TessellationOptions,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): SurfaceResult {
  if (spec.targetKey === null) {
    return makeSurface(oc, spec.shape, null, null, options);
  }
  const target = findStepInput(cache, failedLabels, spec.targetKey);
  return makeSurface(oc, spec.shape, target.shape, target.mesh, options);
}

/**
 * 1 段ぶんの作り手の結果。ねじ穴(FR-406)だけが画面へ返すねじの印(§0.a-0.15)を持つので、
 * それ以外の段は空配列で揃える(createStepSolid が返す形を 1 つに揃えるための入れ物)。
 */
interface StepSolidResult {
  readonly handle: OcctShapeHandle;
  readonly threadMarks: readonly ThreadMarkInfo[];
  /**
   * 作り手がすでに測ってある体積(mm³)。無ければ `buildSolidBodyMesh` がその場で測る。
   *
   * ブーリアンを通る段(和・差・積・穴)は、`booleanOp` が「立体が残ったか」の判定のために
   * 結果の体積を必ず 1 回測っている(`booleanOp.ts` の `BooleanResult`)。同じ形なので
   * 測り直しても同じ値になるだけで、そのぶん(面 26 枚の板で 7.5〜11ms)が無駄になる。
   */
  readonly volume?: number;
  /**
   * 作り手がすでに測ってある表面積(mm²)。無ければ `buildSolidBodyMesh` がその場で測る
   * (求められているときだけ。`SolidBodyMesh.area` の注釈)。
   *
   * いま値を持って帰るのは曲面の段(`makeSurface`)だけで、「面ができたか」の判定のために
   * 結果の面積を必ず 1 回測っている(`makeSurface.ts` の `SurfaceResult`)。
   * 同じ形なので測り直しても同じ値になるだけである(タスク42b)。
   */
  readonly area?: number;
}

/** ねじの印を持たない段の結果を組み立てる(押し出し・穴・面取り・ばね等)。 */
function noMarks(handle: OcctShapeHandle, volume?: number, area?: number): StepSolidResult {
  return { handle, threadMarks: [], volume, area };
}

/**
 * 段の種類ごとに作り手を選ぶ。各節は return で閉じる(no-fallthrough)。
 * 作れないときは、どの作り手も利用者へ見せられる日本語の Error を投げる。
 *
 * **加工の段(穴・ねじ穴・R 面取り・C 面取り)は入力の形と部分形状の一覧が要る**ので、
 * `findStepInput` でキャッシュから取り出す。`CachedSolid.mesh` にはすでに
 * `faces` / `edges` / `vertices` が入っているので、一覧を作り直さない(NFR-PF-2、§2.8)。
 * `mesh` は `SubShapeTables`(`{ faces, edges, vertices }`)の上位互換の形なので、
 * R 面取り・C 面取りへはそのまま渡せる(構造的部分型)。
 * **ばね(FR-414)は `targetKey` を持たないので、この取り出しを行わない**
 * (§0.36。押し出し・回転・縫合と同じ「新しいボディを作る」段)。
 * **基本形状(FR-429)も同じ「作る」段だが、基準点を立体の頂点にしたときだけ
 * `targetKey` の形から頂点を引く**(§0.a-0.18、タスク14b)。それでも対象は消費しない
 * (`createPrimitiveSolid` の注釈)。
 *
 * **P5 の Should 群・Could 群(タスク42a)も同じ 3 通りに分かれる:**
 * - **対象を取らない「作る」段**: スイープ(FR-409)、曲面(FR-428。ただし面を取り出す
 *   作り方だけは対象の形を借りる)。
 * - **対象を借りるが消費しない段**: ミラー(FR-419、§0.a-0.36)、
 *   押し出しの「次の面まで」(FR-415)、曲面の「面を取り出す」(FR-428)。
 * - **対象を消費する段**: 抜き勾配・移動/回転・拡大縮小・リブ・エンボス・外ねじ・
 *   切断・くり抜き。
 *
 * 消費するかどうかを決めているのは段の `visible`(model が組み立てる)で、
 * この関数はそれに一切触れない。ここに書いてあるのは model が取り違えないための覚え書き。
 */
function createStepSolid(
  oc: OpenCascadeInstance,
  spec: SolidStepSpec,
  options: TessellationOptions,
  cache: ShapeCache<CachedSolid>,
  failedLabels: ReadonlyMap<string, string>,
): StepSolidResult {
  switch (spec.kind) {
    case 'extrude':
      // 終端(FR-415)・テーパ(FR-401)・薄板(FR-416)の振り分けは createExtrudeSolid に
      // 集めてある。欄をすべて省いた依頼は P2 からの押し出しと同じ道を通る。
      return noMarks(createExtrudeSolid(oc, spec, options, cache, failedLabels));
    case 'revolve':
      return noMarks(makeRevolveSolid(oc, spec, options));
    case 'sew':
      return noMarks(sewSolid(oc, spec, options));
    case 'boolean': {
      const combined = createBooleanSolid(oc, spec, cache, failedLabels);
      return noMarks(combined, combined.volume);
    }
    case 'hole': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      // 入口の形(ざぐり・皿もみ、FR-422)。省かれていれば makeHole が真っ直ぐな穴にする。
      const drilled = makeHole(oc, spec, target.shape, target.mesh.faces, spec.entry);
      return noMarks(drilled, drilled.volume);
    }
    case 'thread': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      const { handle, marks } = makeThreadHole(oc, spec, target.shape, target.mesh.faces);
      return { handle, threadMarks: marks };
    }
    case 'fillet': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      // 一定半径と可変半径(FR-426)の振り分けは createFilletSolid の 1 か所だけ。
      return noMarks(createFilletSolid(oc, spec, target));
    }
    case 'chamfer': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(makeChamfer(oc, spec, target.shape, target.mesh));
    }
    case 'spring':
      return noMarks(makeSpring(oc, spec));
    case 'primitive':
      // 基本形状(FR-429)。中心・向き・寸法だけで決まるが、基準点を立体の頂点に
      // したときだけ対象の形から頂点を引く(消費はしない。タスク14b)。
      return noMarks(createPrimitiveSolid(oc, spec, cache, failedLabels));
    case 'thruSections':
      // 罫線面(FR-430)とロフト(FR-410)。断面が立体の面(faceQuery)のときだけ
      // 上流の形を見て輪郭を取り出す(タスク24b)。それでも材料にした立体は
      // 消費しない(§0.a-0.27。要るなら利用者が和を取る)。
      return noMarks(createThruSectionsSolid(oc, spec, options, cache, failedLabels));

    // ここから下は P5 の Should 群・Could 群(タスク42a)。
    // 段の型は作り手の依頼(`*Input`)の上位互換なので、詰め替えずにそのまま渡す。

    case 'draft': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(makeDraft(oc, target.shape, target.mesh, spec));
    }
    case 'mirror': {
      // ミラー(FR-419)は対象を消費しない(§0.a-0.36)。鏡像を 1 つ作るだけで、
      // 元と鏡像を 1 つにまとめたければ利用者が和(FR-404)を取る。
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(mirrorShape(oc, target.shape, spec));
    }
    case 'transform': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(transformShape(oc, target.shape, spec));
    }
    case 'scale': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(scaleShape(oc, target.shape, spec));
    }
    case 'sweep':
      // スイープ(FR-409)は対象を取らない「作る」段(ばね・基本形状と同じ)。
      return noMarks(makeSweep(oc, spec));
    case 'rib': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      const ribbed = makeRib(oc, target.shape, spec);
      return noMarks(ribbed, ribbed.volume);
    }
    case 'emboss': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      const embossed = makeEmboss(oc, target.shape, target.mesh, spec);
      return noMarks(embossed, embossed.volume);
    }
    case 'threadShaft': {
      // 外ねじ(FR-423)。ねじ穴と違って**面の一覧だけでなく `SubShapeTables` を丸ごと**渡す
      // (円柱面の軸を読むのに辺・頂点も要る)。印は画面の簡略表示に載る(§0.a-0.15)。
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      const { handle, mark } = makeThreadShaft(oc, target.shape, target.mesh, spec);
      return { handle, threadMarks: [mark] };
    }
    case 'surface': {
      // 曲面(FR-428)。ここだけが `bodyKind: 'shell'` のボディを作る。
      // 判定そのものは buildSolidBodyMesh の hasSolid が行うので、ここに分岐は要らない。
      // 面積は makeSurface が測り済みなので添えて返し、測り直させない(タスク42b)。
      const surface = createSurfaceSolid(oc, spec, options, cache, failedLabels);
      return noMarks(surface, undefined, surface.area);
    }
    case 'cut': {
      // 平面による切断(FR-432)。`makeCut` は積(intersect)を通るので体積を測り済みだが、
      // 平面が対象と交わらない道(複製して返す)では測っていないため、戻りは
      // `OcctShapeHandle` のままにしてある。体積は buildSolidBodyMesh が 1 回測る。
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(makeCut(oc, target.shape, spec));
    }
    case 'shell': {
      const target = findStepInput(cache, failedLabels, spec.targetKey);
      return noMarks(makeShell(oc, target.shape, target.mesh, spec));
    }
  }
}

/**
 * 作った形に表示用データを添えて、キャッシュに預けられる形にする。
 * 三角形分割の途中で断られたときは、預ける前なので自分で形を手放す。
 *
 * 立体になっているかの確認(hasSolid / isValidShape / 体積)は、
 * それぞれの作り手(makeExtrudeSolid・sewSolid・booleanOp・makeHole 等)が済ませている。
 *
 * `threadMarks` はねじ穴の段だけが非空(§0.a-0.15)。それ以外は `noMarks` が空配列にする。
 * `measureAreas` は依頼が表面積を求めたかどうか(`SolidRecomputeRequest` の注釈)。
 * `knownVolume` / `knownArea` は作り手がすでに測ってある体積・表面積
 * (`StepSolidResult.volume` / `.area` の注釈)。
 */
function buildCachedSolid(
  oc: OpenCascadeInstance,
  id: string,
  handle: OcctShapeHandle,
  options: TessellationOptions,
  threadMarks: readonly ThreadMarkInfo[],
  measureAreas: boolean,
  knownVolume?: number,
  knownArea?: number,
): CachedSolid {
  try {
    const mesh = buildSolidBodyMesh(
      oc,
      id,
      handle.shape,
      options,
      threadMarks,
      measureAreas,
      knownVolume,
      knownArea,
    );
    return {
      shape: handle.shape,
      mesh,
      delete(): void {
        handle.delete();
      },
    };
  } catch (error) {
    handle.delete();
    throw error;
  }
}

/**
 * 外観を割り当てた面 1 つを、できたボディの面へ照合し直す(FR-1106、P5 §2.2.3)。
 *
 * 採点は P3 の部分形状の参照とまったく同じ `matchFace`(重み 0.35/0.25/0.2/0.2、
 * しきい値 0.6)で、**外観のための別の規約は作らない**。届かなければ `null` を返し、
 * 呼び出し側(UI)が「見つからない」と断って既定の外観に戻す。
 *
 * 面以外(辺・頂点)の指紋を渡されたときも `null` を返す。外観は面にしか付かないので、
 * 辺や頂点に当てはまる面を探すこと自体に意味が無いためである。
 *
 * `scale` は位置の点を正規化する物差し(境界箱の対角長の半分)。測れなかった形
 * (中身が無く対角長が 0 になる形)では、位置が判断材料にならないまま軸と大きさだけで
 * 当たってしまうので、照合せずに「見つからない」とする。
 */
function matchAppearanceFace(
  query: SubShapeQuery,
  faces: readonly SolidFaceInfo[],
  scale: number,
): number | null {
  if (query.kind !== 'face') {
    return null;
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const found = matchFace(faces, query, scale);
  return found === null ? null : found.index;
}

/**
 * 外観の面の指紋を、できたボディの面へまとめて照合し直す(FR-1106、P5 §2.2.3)。
 *
 * **OCCT を一切使わない純関数。** 引数はすべて `recomputeSolids` が集めた素の値で、
 * 50MB の WASM を読み込まずに Node で検査できる(`matchSubShape.ts` と同じ理由)。
 *
 * 返す並びと件数は依頼と必ず 1 対 1 に対応する(1 件も落とさない)。
 * 画面に出るボディが鍵に見つからないとき — 消費された段(`visible: false`)、
 * 作れなかった段、そもそも履歴から消えた段 — は `bodyId` を空文字、
 * `faceIndex` を `null` にする。**割り当て自体は文書から消さない**ので、
 * 利用者が形を元に戻せば次の再計算で復活する。
 */
export function matchAppearances(
  queries: readonly AppearanceQuery[],
  bodies: readonly SolidBodyMesh[],
  bodyIdByKey: ReadonlyMap<string, string>,
  scaleByBodyId: ReadonlyMap<string, number>,
): readonly AppearanceMatch[] {
  if (queries.length === 0) {
    return [];
  }

  const facesByBodyId = new Map<string, readonly SolidFaceInfo[]>();
  for (const body of bodies) {
    facesByBodyId.set(body.id, body.faces);
  }

  return queries.map((query) => {
    const bodyId = bodyIdByKey.get(query.bodyKey);
    if (bodyId === undefined) {
      return { id: query.id, bodyId: '', faceIndex: null };
    }
    const faces = facesByBodyId.get(bodyId);
    const scale = scaleByBodyId.get(bodyId);
    if (faces === undefined || scale === undefined) {
      return { id: query.id, bodyId, faceIndex: null };
    }
    return { id: query.id, bodyId, faceIndex: matchAppearanceFace(query.query, faces, scale) };
  });
}

/**
 * 履歴の段を先頭から順に計算し直す(要件§6.3、NFR-PF-3、NFR-PF-4、FR-504)。
 *
 * - **鍵で作り直しを省く.** 段の鍵(model が解決済みのパラメータと上流の鍵から作る)が
 *   キャッシュに当たれば、OCCT を呼ばずに覚えていたメッシュをそのまま使う。
 * - **キャッシュの掃除はしない.** 再計算のたびに retain を呼ぶと、Undo で 1 段戻したときに
 *   作り直しが起きる。容量 SHAPE_CACHE_CAPACITY の LRU に任せる(2026-09-03 統括判断)。
 *   段の数が容量を超える依頼では、先頭に近い段から追い出されることになる。
 * - **止めずに理由を出す.** 作れなかった段は failures に積んで次の段へ進む。
 *   その段を入力にするブーリアンも、上流の名前を添えた理由で失敗させて続ける(FR-504)。
 * - **消費されたボディは返さない.** visible が false の段はキャッシュには残るが bodies に入らない
 *   (ブーリアンに食べられた対象と相手。§0.a-0.5)。
 * - **外観の面を選び直す.** 全段を計算し終えたあと、`appearanceQueries` の指紋を
 *   できたボディの面へ照合し直して `appearanceMatches` で返す(FR-1106、P5 §2.2.3)。
 *   依頼が無ければこの段は何もせず、OCCT を 1 回も呼ばない。
 *
 * 進捗と中止は呼び出し側の関数で受け取る。Comlink 越しでは Comlink.proxy した関数が渡る。
 * 中止を尋ねるのは段と段の間だけで、最初の段は必ず計算する。
 */
export async function recomputeSolids(
  deps: SolidRecomputeDeps,
  request: SolidRecomputeRequest,
  options: TessellationOptions = {},
  onProgress?: SolidProgressCallback,
  shouldCancel?: SolidCancelToken,
): Promise<SolidRecomputeResult> {
  const { oc, cache } = deps;
  const total = request.steps.length;
  const bodies: SolidBodyMesh[] = [];
  const failures: SolidStepFailure[] = [];
  /** 作れなかった段の鍵 → その段の表示名。下流の理由に使う。 */
  const failedLabels = new Map<string, string>();
  let cacheHits = 0;
  let cancelled = false;

  const appearanceQueries = request.appearanceQueries ?? [];
  /** 表面積を測るか(統括の決定 2026-09-05)。省略なら測らない。 */
  const measureAreas = request.measureAreas === true;
  /** 外観の依頼が 1 件も無ければ、照合の材料も集めない(§0.a-0.54 の費用ゼロ)。 */
  const collectsAppearance = appearanceQueries.length > 0;
  /** 段の鍵 → 画面に出したボディの id。同じ鍵を複数の段が使うときは先に来た段を採る。 */
  const bodyIdByKey = new Map<string, string>();
  /** ボディの id → 指紋の位置を正規化する物差し(境界箱の対角長の半分。P3 §2.2.3)。 */
  const scaleByBodyId = new Map<string, number>();

  /**
   * 画面に出したボディを照合の材料として覚える。
   *
   * 物差しを測る `boundingDiagonal` は OCCT を呼ぶので、外観の依頼があるときだけ測る。
   * 覚えるのは画面に出るボディだけで、消費された段(`visible: false`)は入れない
   * (見えない面に外観を割り当てても描きようがないため)。
   */
  function rememberBodyForAppearance(key: string, id: string, shape: TopoDS_Shape): void {
    if (!collectsAppearance) {
      return;
    }
    if (!bodyIdByKey.has(key)) {
      bodyIdByKey.set(key, id);
    }
    if (!scaleByBodyId.has(id)) {
      scaleByBodyId.set(id, boundingDiagonal(oc, shape) * 0.5);
    }
  }

  for (let index = 0; index < total; index += 1) {
    const step = request.steps[index];

    // 中止の口が渡されているときだけ制御を譲る。渡されていなければ拾うものが無い。
    if (index > 0 && shouldCancel !== undefined) {
      await yieldToMessages();
      if (await shouldCancel()) {
        cancelled = true;
        break;
      }
    }

    onProgress?.({ stepId: step.id, index, total, label: step.label });

    const cached = cache.get(step.key);
    if (cached !== undefined) {
      cacheHits += 1;
      if (step.visible) {
        // 同じ形を別のフィーチャーが使うことがあるので、id はこの段のものに差し替える。
        // 表面積を求められていて覚えていなければ、覚えてある形からその場で測って足す。
        const mesh = withMeasuredArea(oc, cached.mesh, cached.shape, measureAreas);
        bodies.push({ ...mesh, id: step.id });
        rememberBodyForAppearance(step.key, step.id, cached.shape);
      }
      continue;
    }

    try {
      const stepResult = createStepSolid(oc, step.step, options, cache, failedLabels);
      const meshOptions = resolveTessellationOptions(options, step);
      const entry = buildCachedSolid(
        oc,
        step.id,
        stepResult.handle,
        meshOptions,
        stepResult.threadMarks,
        measureAreas,
        stepResult.volume,
        stepResult.area,
      );
      cache.set(step.key, entry);
      if (step.visible) {
        bodies.push(entry.mesh);
        rememberBodyForAppearance(step.key, step.id, entry.shape);
      }
    } catch (error) {
      failures.push({ id: step.id, message: toFailureMessage(error) });
      failedLabels.set(step.key, step.label);
    }
  }

  return {
    bodies,
    failures,
    cacheHits,
    cancelled,
    // 途中で取り消したときも、そこまでに出来たボディに対して照合しておく。
    // 依頼が空なら空配列が返るだけで、OCCT は 1 回も呼ばれない。
    appearanceMatches: matchAppearances(appearanceQueries, bodies, bodyIdByKey, scaleByBodyId),
  };
}
