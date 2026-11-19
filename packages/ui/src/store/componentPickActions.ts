/**
 * 3D の画面で押した物を、道具の欄へ入れる頼み(配置の補助 P-A の残りと G1。寸法で動かすの基準と向き、規格部品を置く点から始め、
 * ほかの道具も同じ入口を使う)。
 * - 頼む道具は、受け取る欄の種類を渡す。種類ごとに、受ける物が「部品」か「面・辺」か「点」かが決まる(REQUESTERS の表)。
 *   部品の種類(アルミフレーム・鋼材・機械要素・部品のファイル)では分けない(拾いは、部品は部品の選択と同じ scene.pickComponent、
 *   面・辺は合致と同じ pickAssemblyMateTarget、点は一筆書きと同じ frameStrokeHitAt)。
 * - 頼みの間は、3D の画面の押下を部品の選択・ドラッグ・合致へ渡さずここへ渡す(attachAssemblyInteraction)。部品を受ける頼みは、
 *   選ぶ種類の設定(面・辺)によらず部品を拾う。何も無い所の押下は何もしない(選択も空にしない)。
 * - 部品を受ける頼み: 候補の部品なら欄へ入れて頼みを閉じる。候補でない部品なら印を立て、頼みは開いたまま(押し直せる)。
 * - 面・辺を受ける頼み(向き): 平らな面は法線、まっすぐな辺は辺の向き、円柱の面・円の辺・円錐の面は軸の向き(世界の向き。合致と同じ解き方
 *   resolveMateTarget)を欄へ入れて閉じる。向きの取れない物(頂点・球の面など)は印を立て、頼みは開いたまま。
 * - 点を受ける頼み(G1 置く点): 頼んだ時に渡した置く物(規格部品・族の行・部品のファイル)を、押した点に部品の原点が来るように置く
 *   (部品のファイルは X・Y・Z の欄へ入れる)。置けない時は印を立て、頼みは開いたまま。
 * - 頼んだ道具が閉じた後・別の文書へ移った後に残った頼みは、無いものとして扱う(activeComponentPick)。頼み自体は文書にも履歴にも書かない。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  resolveMateTarget, withinMagnitude, type AccessoryChoices, type AccessorySetId, type MateTarget, type Vec3,
} from '@pointercad/model';

import type { PickerJumpTarget } from '../assembly/catalogSearch.js';
import { rememberPlacedPart } from '../assembly/recentStandardParts.js';
import type { StandardPartCategory } from '../assembly/standardPartPicker.js';
import type { AppState } from './appState.js';

export interface ComponentPickSlice {
  /**
   * 頼み: 頼んだ文書、受け取る欄、押してよい部品の id(部品を受ける頼みだけ)、置く物(点を受ける頼みだけ)、最後に押した物を断った印。
   * 頼みが無ければ null。
   */
  readonly assemblyComponentPick: {
    readonly documentId: string;
    readonly purpose: 'dimensionMoveReference' | 'dimensionMoveDirection' | 'placementPoint';
    readonly candidates: readonly string[];
    readonly placement:
      | { readonly kind: 'standardPart'; readonly category: StandardPartCategory; readonly choiceKey: string; readonly lengthSource: string;
        readonly dimensionSeries: 'annexJA' | 'main'; readonly threadSeries: 'coarse' | 'fine';
        readonly accessory: { readonly setId: AccessorySetId; readonly choices: AccessoryChoices } | undefined; readonly recent: PickerJumpTarget }
      | { readonly kind: 'catalogItem'; readonly familyId: string; readonly itemKey: string;
        readonly values: Readonly<Record<string, string>> | undefined;
        readonly accessory: { readonly setId: AccessorySetId; readonly choices: AccessoryChoices } | undefined; readonly recent: PickerJumpTarget }
      | { readonly kind: 'partFile' }
      | null;
    readonly notice: 'notCandidate' | 'notDirection' | 'notPlaced' | null;
  } | null;
  /**
   * 頼む。同じ欄の頼みが開いていれば閉じる(釦の押し直し)。部品を受ける頼みで候補が空の時・点を受ける頼みで置く物が無い時・
   * 頼む道具が開いていない時は頼まない。
   */
  readonly toggleComponentPick: (purpose: NonNullable<ComponentPickSlice['assemblyComponentPick']>['purpose'],
    candidates: readonly string[], placement?: NonNullable<ComponentPickSlice['assemblyComponentPick']>['placement']) => void;
  /** 3D の画面で押した部品を渡す(部品を受ける頼み)。候補なら欄へ入れて true。候補でない時は印を立てて false。頼みが無い時は false。 */
  readonly answerComponentPick: (componentId: string) => boolean;
  /** 3D の画面で押した面・辺を渡す(面・辺を受ける頼み)。向きが取れれば欄へ入れて true。取れない時は印を立てて false。 */
  readonly answerComponentPickTarget: (target: MateTarget | null) => boolean;
  /** 3D の画面で押した点を渡す(点を受ける頼み)。置けたら true(頼みを閉じる)。置けない時は印を立てて false。 */
  readonly answerComponentPickPoint: (point: Vec3) => boolean;
  /** 頼みを閉じる(欄は変えない)。 */
  readonly cancelComponentPick: () => void;
}

type ComponentPick = NonNullable<ComponentPickSlice['assemblyComponentPick']>;
type SetState = (patch: Partial<AppState>) => void;
type Requester =
  | { readonly accepts: 'component'; readonly open: (state: AppState, pick: Omit<ComponentPick, 'notice'>) => boolean;
    readonly deliver: (state: AppState, componentId: string) => void }
  | { readonly accepts: 'faceOrEdge'; readonly open: (state: AppState, pick: Omit<ComponentPick, 'notice'>) => boolean;
    readonly deliver: (state: AppState, direction: Vec3) => void }
  | { readonly accepts: 'point'; readonly open: (state: AppState, pick: Omit<ComponentPick, 'notice'>) => boolean;
    readonly deliver: (state: AppState, point: Vec3, pick: ComponentPick, set: SetState) => boolean };

/** 向き・座標の成分の文字(式の欄が読み戻せる、指数表記の無い書き方。0 とみなす小ささは 0)。 */
const componentText = (value: number): string => (withinMagnitude(value, 1e-12) ? '0' : expressionValueFromNumber(value).source);

/** 寸法で動かすの打ちかけが、頼んだ文書で開いているか。 */
const dimensionMoveOpen = (state: AppState, pick: Omit<ComponentPick, 'notice'>): boolean =>
  state.assemblyDimensionMoveDraft?.documentId === pick.documentId;

/** 点を受ける頼み(G1): 置く物の種類ごとに、押した点へ置く(部品のファイルは欄へ入れる)。 */
function placeAt(state: AppState, point: Vec3, pick: ComponentPick, set: SetState): boolean {
  const placement = pick.placement;
  if (placement === null) return false;
  if (placement.kind === 'partFile') {
    const current = state.assemblyPlacement;
    if (current === null || current.kind !== 'ready') return false;
    set({ assemblyPlacement: { ...current, sources: [componentText(point[0]), componentText(point[1]), componentText(point[2])] } });
    return true;
  }
  const placed = placement.kind === 'standardPart'
    ? state.placeStandardPart(placement.category, placement.choiceKey, placement.lengthSource, placement.dimensionSeries,
      placement.threadSeries, { accessory: placement.accessory, at: point })
    : state.placeCatalogItem(placement.familyId, placement.itemKey, placement.values, placement.accessory, point);
  // 置けた物を最近使った物に覚える(選ぶ窓の「置く」と同じ。K-07b)。
  if (placed) rememberPlacedPart(placement.recent);
  return placed;
}

/**
 * 欄の種類ごとの、受ける物・頼んだ道具が開いているか・受けた物をその道具の欄へ入れる動作(道具を足す時は、ここへ 1 行足す)。
 * 寸法で動かすの向きは、斜め(成分で)の時だけ受ける(軸へ戻すと頼みは無いものになる)。置く点は、置く物の窓が開いている時だけ受ける。
 */
const REQUESTERS: Readonly<Record<ComponentPick['purpose'], Requester>> = {
  dimensionMoveReference: {
    accepts: 'component',
    open: dimensionMoveOpen,
    deliver: (state, componentId) => { state.updateDimensionMoveDraft({ reference: componentId }); },
  },
  dimensionMoveDirection: {
    accepts: 'faceOrEdge',
    open: (state, pick) => dimensionMoveOpen(state, pick) && state.assemblyDimensionMoveDraft?.direction === 'vector',
    deliver: (state, direction) => {
      state.updateDimensionMoveDraft({ vector: [componentText(direction[0]), componentText(direction[1]), componentText(direction[2])] });
    },
  },
  placementPoint: {
    accepts: 'point',
    open: (state, pick) => pick.placement === null ? false
      : pick.placement.kind === 'partFile' ? state.assemblyPlacement?.kind === 'ready' : state.standardPartPickerOpen,
    deliver: placeAt,
  },
};

/** 今の頼み。頼んだ道具が閉じた・別の文書へ移った時は null。3D の画面の押下と窓の表示が使う。 */
export function activeComponentPick(state: AppState): ComponentPickSlice['assemblyComponentPick'] {
  const pick = state.assemblyComponentPick;
  return pick !== null && pick.documentId === state.activeDocumentId && REQUESTERS[pick.purpose].open(state, pick) ? pick : null;
}

/** 今の頼みが受ける物(部品か、面・辺か、点か)。頼みが無ければ null。3D の画面の押下が、何を拾うかを決めるのに使う。 */
export function componentPickAccepts(state: AppState): 'component' | 'faceOrEdge' | 'point' | null {
  const pick = activeComponentPick(state);
  return pick === null ? null : REQUESTERS[pick.purpose].accepts;
}

/** 道具を閉じる時に、その道具の頼みも閉じる欄(ほかの欄の頼みは残す)。 */
export function endComponentPickFor(state: AppState, purposes: readonly ComponentPick['purpose'][]):
Partial<Pick<ComponentPickSlice, 'assemblyComponentPick'>> {
  const pick = state.assemblyComponentPick;
  return pick !== null && purposes.includes(pick.purpose) ? { assemblyComponentPick: null } : {};
}

/** 組立を閉じる・開き直す・編集した時に戻す欄。assemblySlice の片付けが広げて使う。 */
export function emptyComponentPickState(): Pick<ComponentPickSlice, 'assemblyComponentPick'> {
  return { assemblyComponentPick: null };
}

/** 押した面・辺の世界の向き(平らな面の法線、まっすぐな辺・円柱・円・円錐の軸)。取れなければ null。 */
function targetDirection(state: AppState, target: MateTarget): Vec3 | null {
  const view = state.assemblyView;
  if (view === null) return null;
  const outcome = resolveMateTarget(target, view.resolved);
  return outcome.ok && outcome.target.kind !== 'point' ? outcome.target.direction : null;
}

export function createComponentPickActions(set: SetState, get: () => AppState): Omit<ComponentPickSlice, 'assemblyComponentPick'> {
  /** 断った印を立てる(頼みは開いたまま)。 */
  const refuse = (pick: ComponentPick, notice: NonNullable<ComponentPick['notice']>): false => {
    set({ assemblyComponentPick: { ...pick, notice } });
    return false;
  };
  return {
    toggleComponentPick: (purpose, candidates, placement = null) => {
      const state = get();
      const requester = REQUESTERS[purpose];
      const next = { documentId: state.activeDocumentId, purpose, candidates: [...candidates], placement };
      const closing = activeComponentPick(state)?.purpose === purpose;
      const refused = (requester.accepts === 'component' && candidates.length === 0)
        || (requester.accepts === 'point' && placement === null) || !requester.open(state, next);
      set({ assemblyComponentPick: closing || refused ? null : { ...next, notice: null } });
    },
    answerComponentPick: (componentId) => {
      const pick = activeComponentPick(get());
      if (pick === null) return false;
      const requester = REQUESTERS[pick.purpose];
      if (requester.accepts !== 'component' || !pick.candidates.includes(componentId)) return refuse(pick, 'notCandidate');
      set({ assemblyComponentPick: null });
      requester.deliver(get(), componentId);
      return true;
    },
    answerComponentPickTarget: (target) => {
      const state = get();
      const pick = activeComponentPick(state);
      if (pick === null) return false;
      const requester = REQUESTERS[pick.purpose];
      const direction = requester.accepts !== 'faceOrEdge' || target === null ? null : targetDirection(state, target);
      if (requester.accepts !== 'faceOrEdge' || direction === null) return refuse(pick, 'notDirection');
      set({ assemblyComponentPick: null });
      requester.deliver(get(), direction);
      return true;
    },
    answerComponentPickPoint: (point) => {
      const pick = activeComponentPick(get());
      if (pick === null) return false;
      const requester = REQUESTERS[pick.purpose];
      if (requester.accepts !== 'point') return refuse(pick, 'notPlaced');
      // 置く(文書を 1 回で変える)前に頼みを閉じ、置けなかった時だけ印を立てて開き直す。
      set({ assemblyComponentPick: null });
      return requester.deliver(get(), point, pick, set) || refuse(pick, 'notPlaced');
    },
    cancelComponentPick: () => { set({ assemblyComponentPick: null }); },
  };
}
