/**
 * 図形の測定値の「いまの値」の判定(ADD-23、計画書 geomref-plan.md §4(c)、GR-14)。
 *
 * 再計算の結果(`PartRecomputeResult.mathGeometry`)は、`applyRecompute` が「計算した文書・
 * 世代」と一緒にストアの `mathGeometryResult` へ控える(`store/recomputeSlice.ts`)。
 * 画面(一覧・係数行・数式入力・状態欄)はその控えを直接読まず、**必ずここを通す**。判定を
 * 1 か所にまとめ、状況のコードだけを返す(文言は持たない。i18n の鍵は画面側が引く)。
 *
 * 値を出すのは「いま画面に出ている部品の文書」と「その世代の完了した計算」が揃うときだけ。
 * 形の変更直後・取消・新規・開く・復元・Undo/Redo・世代交代・履歴の途中表示(Q12=H1)では
 * 出さない。**文書ID は十分条件にしない**(既定ID `part-1` は一意でない)。文書オブジェクトと
 * 形の欄の同一性(`affectsShape` は参照比較)と世代で判定する。外観・名前だけの変更は
 * `affectsShape` が偽なので値を保つ。
 */
import { affectsShape, type MathGeometryOutcome, type PartDocument } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * `applyRecompute` が控える 1 回分の結果。値は導出値なので保存しない(rules/04)。
 * ストアはこの型を `import type` だけで読む(読み込みの輪を作らない)。
 */
export interface MathGeometryResultSnapshot {
  /** `applyRecompute` が受け取った「計算した文書」そのもの。 */
  readonly document: PartDocument;
  /** その計算の世代(`PartRecomputeResult.generation`)。 */
  readonly generation: number;
  /**
   * 測定まで進んだか(`result.mathGeometry !== undefined`)。形の計算部の呼び出しや数式の
   * 前段が失敗した結果には測定値が付かないので false になる(申し送り §2.3-②)。
   */
  readonly evaluated: boolean;
  /** 定義ID → 結果。未解決の理由(5種)と model の文をそのまま持つ(落とさない)。 */
  readonly outcomes: ReadonlyMap<string, MathGeometryOutcome>;
}

/** 未解決の理由(model の 5 種)。文言の対応(GR-19a)はこの型の網羅の表で漏れを落とす。 */
export type MathGeometryUnresolvedReason =
  Extract<MathGeometryOutcome, { readonly status: 'unresolved' }>['reason'];

/** 判定に使う欄だけ。ストア全体を要求しないので、検査から素の値も渡せる。 */
export type MathGeometryResultState = Pick<
  AppState,
  | 'document'
  | 'assembly'
  | 'drawing'
  | 'timelineIndex'
  | 'recomputeCancelled'
  | 'mathGeometryResult'
  | 'requestedGeneration'
  | 'completedGeneration'
  | 'lastOutcome'
  | 'partErrors'
  | 'errorMessage'
>;

/**
 * 判定の結果。`status` は i18n の鍵 `mathGeometry.status.*`(computing・cancelled・timeline・
 * notEvaluated)と同じ綴りにしてある。
 */
export type CurrentMathGeometry =
  /** 部品を開いていない(アセンブリ・図面)。節を出さない。 */
  | { readonly status: 'notPart' }
  /** 履歴の途中を表示している(Q12=H1)。値を出さない。 */
  | { readonly status: 'timeline' }
  /** 最新の計算を中止した。形を計算し直すまで値を出さない。 */
  | { readonly status: 'cancelled' }
  /** 形の変更直後・Undo/Redo・開く・新規・復元・構成切替・世代交代。終わるまで値を出さない。 */
  | { readonly status: 'computing' }
  /**
   * 形を作れず測っていない(定義がある文書だけ)。`message` は最初の失敗の理由
   * (`partErrors` の先頭。計算そのものが例外で終わったときはその理由)。無ければ null。
   */
  | { readonly status: 'notEvaluated'; readonly message: string | null }
  /** いまの文書・その世代の完了した結果。定義ごとの未解決もここに理由付きで入る。 */
  | {
      readonly status: 'current';
      readonly generation: number;
      readonly outcomes: ReadonlyMap<string, MathGeometryOutcome>;
    };

export type MathGeometryResultStatus = CurrentMathGeometry['status'];

/*
 * 同じ状態には同じ物を返す(Zustand 5 の選択関数から呼んでも、呼ぶたびに新しい物を
 * 返して描き直しが止まらなくなることがないように)。
 */
const NOT_PART = Object.freeze({ status: 'notPart' as const });
const TIMELINE = Object.freeze({ status: 'timeline' as const });
const CANCELLED = Object.freeze({ status: 'cancelled' as const });
const COMPUTING = Object.freeze({ status: 'computing' as const });
type CurrentValue = Extract<CurrentMathGeometry, { readonly status: 'current' }>;
type NotEvaluatedValue = Extract<CurrentMathGeometry, { readonly status: 'notEvaluated' }>;
const currentBySnapshot = new WeakMap<MathGeometryResultSnapshot, CurrentValue>();
let lastNotEvaluated: NotEvaluatedValue | null = null;

function currentOf(snapshot: MathGeometryResultSnapshot): CurrentValue {
  const cached = currentBySnapshot.get(snapshot);
  if (cached !== undefined) {
    return cached;
  }
  const value: CurrentValue = Object.freeze({
    status: 'current' as const,
    generation: snapshot.generation,
    outcomes: snapshot.outcomes,
  });
  currentBySnapshot.set(snapshot, value);
  return value;
}

function notEvaluated(message: string | null): NotEvaluatedValue {
  if (lastNotEvaluated === null || lastNotEvaluated.message !== message) {
    lastNotEvaluated = Object.freeze({ status: 'notEvaluated' as const, message });
  }
  return lastNotEvaluated;
}

function hasDefinitions(document: PartDocument): boolean {
  return (document.mathGeometry?.length ?? 0) > 0;
}

/**
 * いま画面に出ている部品の図形の測定値の状況(§4(c) の表)。道具が有効かどうかとは無関係に、
 * 一覧・係数行・数式入力・状態欄が同じこの判定を使う。上から順に当てはめる:
 *
 * 1. 部品以外(アセンブリ・図面) → `notPart`
 * 2. 履歴の途中表示 → `timeline`
 * 3. 取消 → `cancelled`
 * 4. 控えが無い・世代が違う・控えを作った後に形の欄が変わった → `computing`
 *    (ただし最新の依頼が控えを残さずに終わった場合は、取消なら `cancelled`、計算そのものが
 *    例外で終わったなら `notEvaluated`。外観の変更では再計算が起きないので、ここで
 *    `computing` を返すと値が戻らないまま止まるため)
 * 5. 定義があるのに測っていない(形を作れなかった) → `notEvaluated`
 * 6. それ以外 → `current`
 */
export function currentMathGeometry(state: MathGeometryResultState): CurrentMathGeometry {
  const document = activePartDocument(state);
  if (document === null) {
    return NOT_PART;
  }
  if (state.timelineIndex !== null) {
    return TIMELINE;
  }
  if (state.recomputeCancelled) {
    return CANCELLED;
  }
  const snapshot = state.mathGeometryResult;
  if (snapshot === null || snapshot.generation !== state.requestedGeneration) {
    if (state.completedGeneration === state.requestedGeneration) {
      // 最新の依頼は終わったのに、その世代の控えが無い。
      if (state.lastOutcome === 'cancelled') {
        return CANCELLED;
      }
      if (state.lastOutcome === 'failed') {
        return notEvaluated(state.errorMessage ?? state.partErrors[0]?.message ?? null);
      }
    }
    return COMPUTING;
  }
  // 文書ID は必要条件としてだけ見る(model の照合 `outcome.documentId === document.id` と揃える)。
  if (snapshot.document.id !== document.id || affectsShape(snapshot.document, document)) {
    return COMPUTING;
  }
  if (!snapshot.evaluated && hasDefinitions(document)) {
    return notEvaluated(state.partErrors[0]?.message ?? null);
  }
  return currentOf(snapshot);
}

/** 定義を持たない文書へ渡す空の表(測る値が要らないので、待つ必要も無い)。 */
const NO_INPUTS: ReadonlyMap<string, MathGeometryOutcome> = new Map<string, MathGeometryOutcome>();

/**
 * 数式の評価へ渡す図形の測定値(`DocumentMathContext.geometry`、GR-04)。
 *
 * - 定義を持たない文書には空の表を返す(何も測らないので、計算中でも待たずに評価できる)。
 * - `document` がいま画面に出ている部品の文書そのものでなければ null(古い文書へ新しい値や
 *   同じ `part-1` の別文書の値を渡さない)。
 * - 判定(`currentMathGeometry`)が `current` でなければ null。呼び出し側は
 *   `waitForCurrentMathGeometry` で待つか、「形の計算が終わってから」と断る(文書は変えない)。
 *
 * 返す表は「その文書・その世代の完了した計算」の結果だけで、未解決・真偽の結果も理由付きの
 * まま含む(扱いは model の `evaluateDocumentMath` が決める。古い値へ置き換えない)。
 */
export function mathGeometryInputsFor(
  state: MathGeometryResultState,
  document: PartDocument,
): ReadonlyMap<string, MathGeometryOutcome> | null {
  if (!hasDefinitions(document)) {
    return NO_INPUTS;
  }
  if (activePartDocument(state) !== document) {
    return null;
  }
  const current = currentMathGeometry(state);
  return current.status === 'current' ? current.outcomes : null;
}

/** 待ち終えたときの結果。`computing`・`timeline` の間は待ち続けるので返らない。 */
export type MathGeometryWaitResult =
  | Exclude<CurrentMathGeometry, { readonly status: 'computing' | 'timeline' }>
  | { readonly status: 'aborted' };

const ABORTED = Object.freeze({ status: 'aborted' as const });

/**
 * 図形の測定値が「いまの値」になるまで待つ(数式の編集画面や、評価の入口が使う)。
 *
 * - `current` になったらその判定を返す。
 * - 計算中(`computing`)と履歴の途中表示(`timeline`。つまみを末尾へ戻せば計算が走る)の
 *   間は待ち続ける。
 * - `cancelled`・`notEvaluated`・`notPart` は文書が変わらない限り自然には値にならないので、
 *   その判定をすぐ返す(呼び出し側が理由を出して止める)。
 * - `signal` が中止されたら `aborted` を返す。待つのをやめたら購読は必ず外す。
 *
 * 返した後で文書が変わっていないかは、呼び出し側が自分の `isCurrent` で確かめ、値は
 * `mathGeometryInputsFor(state, document)` で読み直す。
 */
export function waitForCurrentMathGeometry(signal?: AbortSignal): Promise<MathGeometryWaitResult> {
  return new Promise<MathGeometryWaitResult>((resolve) => {
    if (signal?.aborted === true) {
      resolve(ABORTED);
      return;
    }
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    function settle(value: MathGeometryWaitResult): void {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    }
    function onAbort(): void {
      settle(ABORTED);
    }
    function check(state: MathGeometryResultState): void {
      const current = currentMathGeometry(state);
      if (current.status !== 'computing' && current.status !== 'timeline') {
        settle(current);
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribe = useAppStore.subscribe(check);
    check(useAppStore.getState());
  });
}
