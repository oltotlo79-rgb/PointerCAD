/** 板金の道具・一時的な実形状プレビュー。保存する定義はdocumentだけ。 */
import type { PartDocument, PartRecomputeResult, ResolvedSheetBody, SolidBody, SheetConvertLookup, SheetMetalFeature, SheetFlatGeometry, SheetFlatResult,
  SheetUnfoldDefinition } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AppState } from './appState.js';
import type { SheetOutputComputer } from '../sheetMetal/sheetOutputComputer.js';
import { snapshotSheetMetalDefaultSources, type SheetMetalDefaultSourceSnapshot } from '../sheetMetal/sheetMetalDefaultSources.js';

export type SheetMetalToolKind = 'sheetBase' | 'sheetFlange' | 'sheetBend' | 'sheetRelief' | 'sheetConvert' | 'sheetUnfold';
export interface SheetMetalToolSession {
  readonly id: string; readonly kind: SheetMetalToolKind;
  readonly document: PartDocument; readonly documentId: string;
  readonly editingFeature?: SheetMetalFeature;
  /** 開始時の端末設定。既存の有効な編集欄は含めない。 */
  readonly defaultSources?: SheetMetalDefaultSourceSnapshot;
}
export interface SheetMetalPreview {
  readonly session: SheetMetalToolSession; readonly candidate: PartDocument;
  readonly bodies: readonly SolidBody[]; readonly featureId: string; readonly volume: number;
  readonly flat?: { readonly definition: SheetUnfoldDefinition; readonly geometry: SheetFlatGeometry };
}
export type SheetMetalComputer = (document: PartDocument, requestId: string, shouldCancel: () => boolean) => Promise<PartRecomputeResult>;
export type SheetMetalFlatComputer = (body: ResolvedSheetBody, definition: SheetUnfoldDefinition,
  requestId: string, shouldCancel: () => boolean) => Promise<SheetFlatResult>;
export interface SheetMetalSlice {
  readonly sheetMetalTool: SheetMetalToolSession | null;
  readonly sheetMetalBodies: ReadonlyMap<string, ResolvedSheetBody>;
  readonly sheetMetalPreview: SheetMetalPreview | null;
  readonly sheetMetalRequestId: string | null;
  readonly sheetMetalError: string | null;
  readonly sheetMetalComputer: SheetMetalComputer | null;
  readonly sheetMetalFlatComputer: SheetMetalFlatComputer | null;
  readonly sheetOutputComputer: SheetOutputComputer | null;
  /**
   * 立体を板金へ変える行(M-08)の認識の答えを引く口(再計算が持ち回る覚え書きの lookup。PointerCadApp が付ける)。
   * 画面の純な解決(板金の窓の対象の一覧・確定前の確かめ)へ渡し、変換した板金を後段の元にできるようにする。
   */
  readonly sheetRecognitionLookup: SheetConvertLookup | null;
  readonly setSheetOutputComputer: (computer: SheetOutputComputer | null) => void;
  readonly setSheetRecognitionLookup: (lookup: SheetConvertLookup | null) => void;
  readonly setSheetMetalComputer: (computer: SheetMetalComputer | null) => void;
  readonly setSheetMetalFlatComputer: (computer: SheetMetalFlatComputer | null) => void;
  readonly clearSheetMetalPreview: () => void;
  readonly openSheetMetalTool: (kind: SheetMetalToolKind, featureId?: string) => void;
  readonly closeSheetMetalTool: () => void;
}
export type SheetMetalInitialState = Pick<SheetMetalSlice, 'sheetMetalTool' | 'sheetMetalBodies' | 'sheetMetalPreview' | 'sheetMetalRequestId' | 'sheetMetalError'>;
export function emptySheetMetalTool(): Omit<SheetMetalInitialState, 'sheetMetalBodies'> {
  return { sheetMetalTool: null, sheetMetalPreview: null, sheetMetalRequestId: null, sheetMetalError: null };
}
export const createSheetMetalSlice: StateCreator<AppState, [], [], Omit<SheetMetalSlice, keyof SheetMetalInitialState>> = (set, get) => ({
  sheetMetalComputer: null,
  sheetMetalFlatComputer: null,
  sheetOutputComputer: null,
  sheetRecognitionLookup: null,
  setSheetOutputComputer: (sheetOutputComputer) => set({ sheetOutputComputer }),
  setSheetRecognitionLookup: (sheetRecognitionLookup) => set({ sheetRecognitionLookup }),
  setSheetMetalComputer: (sheetMetalComputer) => set({ sheetMetalComputer }),
  setSheetMetalFlatComputer: (sheetMetalFlatComputer) => set({ sheetMetalFlatComputer }),
  clearSheetMetalPreview: () => set({ sheetMetalPreview: null, sheetMetalRequestId: null, sheetMetalError: null }),
  openSheetMetalTool: (kind, featureId) => {
    const state = get();
    if (state.assembly !== null || state.drawing !== null) return;
    const editing = featureId === undefined ? undefined : state.document.solids.find((feature) => feature.id === featureId);
    if (featureId !== undefined && (editing === undefined || editing.kind !== kind)) return;
    const editingFeature = editing?.kind === 'sheetBase' || editing?.kind === 'sheetFlange' || editing?.kind === 'sheetBend' || editing?.kind === 'sheetRelief'
      || editing?.kind === 'sheetConvert' ? editing : undefined;
    const selection = state.selection;
    const defaultSources = snapshotSheetMetalDefaultSources(state.displaySettings.numericToolDefaults, editingFeature);
    state.setActiveTool('select');
    set({ ...emptySheetMetalTool(), sheetMetalTool: { id: crypto.randomUUID(), kind, document: state.document, documentId: state.activeDocumentId,
      defaultSources, ...(editingFeature === undefined ? {} : { editingFeature }) }, selection,
      selectionKind: kind === 'sheetFlange' || kind === 'sheetRelief' ? 'edge' : 'face' });
  },
  closeSheetMetalTool: () => set(emptySheetMetalTool()),
});
