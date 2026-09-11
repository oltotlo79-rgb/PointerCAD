import type { BOPAlgo_GlueEnum, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { isValidShape, measureVolume } from './solidMesh.js';

/** この体積(mm³)を厳密に超える共通部分だけを干渉とする(P7 §2.7、FR-615)。 */
export const MIN_INTERFERENCE_VOLUME_MM3 = 1e-6;

export type IntersectionVolumeStage =
  | 'input'
  | 'createBuilder'
  | 'setInputs'
  | 'setNonDestructive'
  | 'setGlue'
  | 'setHistory'
  | 'setCheckInverted'
  | 'build'
  | 'checkBuild'
  | 'readShape'
  | 'inspectResult'
  | 'measure'
  | 'validateResult'
  | 'release';

export interface IntersectionVolumeFailure {
  readonly code:
    | 'invalidInput'
    | 'buildFailed'
    | 'invalidResult'
    | 'measurementFailed'
    | 'occtException'
    | 'cleanupFailed';
  readonly stage: IntersectionVolumeStage;
  readonly message: string;
  readonly detail?: string;
  readonly cleanupMessages?: readonly string[];
}

export type IntersectionVolumeResult =
  | (OcctShapeHandle & { readonly kind: 'overlap'; readonly volume: number })
  | {
      readonly kind: 'clear';
      readonly reason: 'empty' | 'belowThreshold';
      readonly volume: number;
      readonly shape: null;
    }
  | {
      readonly kind: 'failed';
      readonly volume: null;
      readonly shape: null;
      readonly failure: IntersectionVolumeFailure;
    };

export interface IntersectionVolumeOptions {
  /** 呼出側が新しい面交線のない部分一致を証明した場合だけ指定する。省略時は従来通り。 */
  readonly glue?: 'shift';
  /** 結果APIはModified/Generated履歴を返さない。省略時はOCCT既定を維持する。 */
  readonly collectHistory?: false;
  /** 呼出側が有界solidの外向き閉包を証明済みの場合だけtrue。結果の妥当性検査は維持。 */
  readonly nonInverted?: true;
  /**
   * 呼出側が、同じ妥当な軸平行直方体の1軸平行移動で、しきい値を十分に超える
   * 正体積の共通部分まで証明済みの場合だけtrue。Commonと厳密体積測定は省かず、
   * 入力2形状のSOLID走査と、捨てる結果B-repの重複SOLID/妥当性走査だけを省く。
   */
  readonly certifiedBoxOverlap?: true;
}

/**
 * 固定bindingは列挙値を{}、SetGlue引数を列挙の入れ物として宣言している。
 * 2026-09-08 PM承認の述語1箇所。makeSweep/xcafDocumentと同じ限定例外で、
 * 他APIへ広げない。実WASMで列挙のconstructor・instance・value=1を確認済み。
 * nullでないことだけでなく登録値の同一性とその実行時構造を検査する。
 * この検査は幾何へのGlue適用条件を証明しない。その証明は呼出側が所有する。
 */
function isGlueShift(value: unknown, registry: unknown): value is BOPAlgo_GlueEnum {
  return typeof registry === 'function' && 'BOPAlgo_GlueShift' in registry
    && registry.BOPAlgo_GlueShift === value && typeof value === 'object' && value !== null
    && value instanceof registry && 'value' in value && value.value === 1
    && typeof value.constructor === 'function' && value.constructor.name === 'BOPAlgo_GlueEnum_BOPAlgo_GlueShift';
}

function glueShift(oc: OpenCascadeInstance): BOPAlgo_GlueEnum {
  const registry: unknown = oc.BOPAlgo_GlueEnum;
  const value: unknown = typeof registry === 'function' && 'BOPAlgo_GlueShift' in registry
    ? registry.BOPAlgo_GlueShift : undefined;
  if (!isGlueShift(value, registry)) throw new Error('OCCTのGlueShift列挙を確認できませんでした。');
  return value;
}

function failed(failure: IntersectionVolumeFailure): IntersectionVolumeResult {
  return { kind: 'failed', volume: null, shape: null, failure };
}

function exceptionDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 一次例外を上書きせず、他の所有群も最後まで解放するために記録して戻る。 */
function releaseSafely(allocations: Allocations, cleanupMessages: string[]): void {
  try {
    allocations.release();
  } catch (error) {
    cleanupMessages.push(exceptionDetail(error));
  }
}

function containsSolid(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  cleanupMessages: string[],
): boolean {
  const allocations = createAllocations();
  try {
    const map = allocations.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const count = map.Size();
    for (let index = 1; index <= count; index += 1) {
      // FindKey は独立した所有ラッパーを返す(固定 WASM、R-3 の実測)。
      // 下位 TShape は借用入力と共有するが、その入力自体は keep/delete しない。
      const subShape = allocations.keep(map.FindKey(index));
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) return true;
    }
    return false;
  } finally {
    releaseSafely(allocations, cleanupMessages);
  }
}

/**
 * 同じ世界座標に置かれた2立体の共通体積。入力は借用し、配置や形を変更しない。
 * 空の Common → 入力指定 → 非破壊指定 → Build の順は固定 WASM で実証済み。
 * 入力を constructor に渡すと指定前に計算が始まるので Common_1 を使う。
 *
 * overlap の所有は返却 handle 全体へ移す。呼出側は必ず finally で delete() し、
 * 結果 shape → maker → range の順に解放する。delete は2回目も安全で、解放例外は
 * 残りを全て試した後に投げる。clear/failed は返却時に所有物を残さない。
 * 結果も入力と下位 TShape を共有し得るため、後続のメッシュ化は複製に対して行う。
 *
 * 同期の Common 内へ新しい中止要求は割り込めない。Worker の呼出側が組の前後で
 * 中止を確認する。この関数は進捗・中止・永続状態を持たない。
 */
export function intersectionVolume(
  oc: OpenCascadeInstance,
  a: TopoDS_Shape,
  b: TopoDS_Shape,
  options: IntersectionVolumeOptions = {},
): IntersectionVolumeResult {
  const allocations = createAllocations();
  const cleanupMessages: string[] = [];
  let stage: IntersectionVolumeStage = 'input';

  function calculate(): IntersectionVolumeResult {
    const aIsNull = a.IsNull();
    const bIsNull = b.IsNull();
    const certifiedBoxOverlap = options.certifiedBoxOverlap === true;
    if (aIsNull || bIsNull || (!certifiedBoxOverlap
      && (!containsSolid(oc, a, cleanupMessages) || !containsSolid(oc, b, cleanupMessages)))) {
      return failed({ code: 'invalidInput', stage, message: '重なりを調べる立体がありません。' });
    }

    stage = 'createBuilder';
    const range = allocations.keep(new oc.Message_ProgressRange_1());
    const maker = allocations.keep(new oc.BRepAlgoAPI_Common_1());
    const inputs = createAllocations();
    try {
      stage = 'setInputs';
      const argumentsList = inputs.keep(new oc.TopTools_ListOfShape_1());
      const toolsList = inputs.keep(new oc.TopTools_ListOfShape_1());
      // Append_1 の戻りも独立した所有ラッパー(R-3 の固定 WASM 実測)。
      // 戻りをリストより先に解放し、借りた a/b のラッパーは解放しない。
      inputs.keep(argumentsList.Append_1(a));
      inputs.keep(toolsList.Append_1(b));
      maker.SetArguments(argumentsList);
      maker.SetTools(toolsList);
      stage = 'setNonDestructive';
      maker.SetNonDestructive(true);
      if (options.glue === 'shift') {
        stage = 'setGlue';
        maker.SetGlue(glueShift(oc));
      }
      if (options.collectHistory === false) {
        stage = 'setHistory';
        maker.SetToFillHistory(false);
      }
      if (options.nonInverted === true) {
        stage = 'setCheckInverted';
        maker.SetCheckInverted(false);
      }
      stage = 'build';
      maker.Build(range);
    } finally {
      releaseSafely(inputs, cleanupMessages);
    }

    stage = 'checkBuild';
    if (maker.HasErrors() || !maker.IsDone()) {
      return failed({ code: 'buildFailed', stage, message: '立体の重なりを計算できませんでした。位置や形を見直してください。' });
    }
    stage = 'readShape';
    const shape = allocations.keep(maker.Shape());
    // 固定 WASM の正常な空結果は非nullの空 COMPOUND。予期しないnullは失敗。
    if (shape.IsNull()) {
      return failed({ code: 'invalidResult', stage, message: '重なりの形を取得できませんでした。' });
    }
    stage = 'inspectResult';
    if (!certifiedBoxOverlap && !containsSolid(oc, shape, cleanupMessages)) {
      return { kind: 'clear', reason: 'empty', volume: 0, shape: null };
    }
    stage = 'measure';
    // 認証済み直方体同士の共通部分は平面だけで囲まれる。周期曲線の探索だけを省く。
    const volume = measureVolume(oc, shape, certifiedBoxOverlap);
    if (!Number.isFinite(volume) || volume < 0) {
      return failed({ code: 'measurementFailed', stage, message: '重なりの体積を正しく測れませんでした。' });
    }
    stage = 'validateResult';
    if (!certifiedBoxOverlap && !isValidShape(oc, shape)) {
      return failed({ code: 'invalidResult', stage, message: '重なりの形が正しくありませんでした。' });
    }
    if (volume <= MIN_INTERFERENCE_VOLUME_MM3) {
      return { kind: 'clear', reason: 'belowThreshold', volume, shape: null };
    }
    return { kind: 'overlap', volume, shape, delete: allocations.release };
  }

  let result: IntersectionVolumeResult;
  try {
    result = calculate();
  } catch (error) {
    result = failed({
      code: 'occtException', stage,
      message: '立体の重なりを調べられませんでした。位置や形を見直してください。',
      detail: exceptionDetail(error),
    });
  }
  if (result.kind !== 'overlap' || cleanupMessages.length > 0) {
    releaseSafely(allocations, cleanupMessages);
  }
  if (cleanupMessages.length === 0) return result;
  if (result.kind === 'failed') {
    return failed({ ...result.failure, cleanupMessages });
  }
  return failed({
    code: 'cleanupFailed', stage: 'release',
    message: '重なりを調べた後の片付けに失敗しました。', cleanupMessages,
  });
}
