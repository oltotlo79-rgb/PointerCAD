/** 板金の道具・一時的な実形状プレビュー。保存する定義はdocumentだけ。 */
import type { PartDocument, PartRecomputeResult, ResolvedSheetBody, SolidBody, SheetMetalFeature, SheetFlatGeometry, SheetFlatResult, SheetUnfoldDefinition } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AppState } from './appState.js';
import type { SheetOutputComputer } from '../sheetMetal/sheetOutputComputer.js';

export type SheetMetalToolKind = 'sheetBase' | 'sheetFlange' | 'sheetBend' | 'sheetRelief' | 'sheetUnfold';
export interface SheetMetalToolSession {
  readonly id: string; readonly kind: SheetMetalToolKind;
  readonly document: PartDocument; readonly documentId: string;
  readonly editingFeature?: SheetMetalFeature;
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
  readonly setSheetOutputComputer: (computer: SheetOutputComputer | null) => void;
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
  setSheetOutputComputer: (sheetOutputComputer) => set({ sheetOutputComputer }),
  setSheetMetalComputer: (sheetMetalComputer) => set({ sheetMetalComputer }),
  setSheetMetalFlatComputer: (sheetMetalFlatComputer) => set({ sheetMetalFlatComputer }),
  clearSheetMetalPreview: () => set({ sheetMetalPreview: null, sheetMetalRequestId: null, sheetMetalError: null }),
  openSheetMetalTool: (kind, featureId) => {
    const state = get();
    if (state.assembly !== null || state.drawing !== null) return;
    const editing = featureId === undefined ? undefined : state.document.solids.find((feature) => feature.id === featureId);
    if (featureId !== undefined && (editing === undefined || editing.kind !== kind)) return;
    const editingFeature = editing?.kind === 'sheetBase' || editing?.kind === 'sheetFlange' || editing?.kind === 'sheetBend' || editing?.kind === 'sheetRelief' ? editing : undefined;
    const selection = state.selection;
    state.setActiveTool('select');
    set({ ...emptySheetMetalTool(), sheetMetalTool: { id: crypto.randomUUID(), kind, document: state.document, documentId: state.activeDocumentId,
      ...(editingFeature === undefined ? {} : { editingFeature }) }, selection,
      selectionKind: kind === 'sheetFlange' || kind === 'sheetRelief' ? 'edge' : 'face' });
  },
  closeSheetMetalTool: () => set(emptySheetMetalTool()),
});
