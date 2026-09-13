import type { FunctionCurveGeometryOutcome, PartDocument, SolidBody } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { AppState } from './appState.js';

export type FunctionPlotComputer = (document: PartDocument, featureId: string, shouldCancel: () => boolean) => Promise<FunctionCurveGeometryOutcome>;
export type FunctionSurfacePlotOutcome = { readonly status: 'ready'; readonly body: SolidBody }
  | { readonly status: 'failed'; readonly message: string } | { readonly status: 'cancelled' };
export type FunctionSurfacePlotComputer = (document: PartDocument, featureId: string, shouldCancel: () => boolean) => Promise<FunctionSurfacePlotOutcome>;
export interface FunctionPlotSlice {
  readonly functionPlotComputer: FunctionPlotComputer | null;
  readonly setFunctionPlotComputer: (computer: FunctionPlotComputer | null) => void;
  readonly functionSurfacePlotComputer: FunctionSurfacePlotComputer | null;
  readonly setFunctionSurfacePlotComputer: (computer: FunctionSurfacePlotComputer | null) => void;
}
export const createFunctionPlotSlice: StateCreator<AppState, [], [], FunctionPlotSlice> = set => ({
  functionPlotComputer: null, setFunctionPlotComputer: functionPlotComputer => set({ functionPlotComputer }),
  functionSurfacePlotComputer: null, setFunctionSurfacePlotComputer: functionSurfacePlotComputer => set({ functionSurfacePlotComputer }),
});
