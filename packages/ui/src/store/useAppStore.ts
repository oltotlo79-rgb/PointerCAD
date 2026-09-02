import type { PartMesh } from '@pointercad/model';
import { create } from 'zustand';

/** 透視投影 / 平行投影(FR-102)。 */
export type ProjectionMode = 'perspective' | 'orthographic';

/** 表示スタイル 3 種(FR-105)。 */
export type DisplayStyle = 'shaded' | 'shadedWithEdges' | 'wireframe';

export interface AppState {
  readonly documentName: string;
  readonly featureNames: readonly string[];
  readonly mesh: PartMesh | null;
  readonly isComputing: boolean;
  readonly errorMessage: string | null;
  readonly projection: ProjectionMode;
  readonly displayStyle: DisplayStyle;
  readonly showGrid: boolean;
  /** ホーム視点への復帰要求を数える(FR-108)。増えるたびにビューポートが反応する。 */
  readonly homeViewRequestCount: number;

  setDocument(name: string, featureNames: readonly string[]): void;
  setMesh(mesh: PartMesh): void;
  setComputing(isComputing: boolean): void;
  setError(message: string | null): void;
  setProjection(projection: ProjectionMode): void;
  setDisplayStyle(displayStyle: DisplayStyle): void;
  setShowGrid(showGrid: boolean): void;
  requestHomeView(): void;
}

export const useAppStore = create<AppState>()((set) => ({
  documentName: '',
  featureNames: [],
  mesh: null,
  isComputing: false,
  errorMessage: null,
  projection: 'perspective',
  displayStyle: 'shadedWithEdges',
  showGrid: true,
  homeViewRequestCount: 0,

  setDocument: (documentName, featureNames) => {
    set({ documentName, featureNames });
  },
  setMesh: (mesh) => {
    set({ mesh, errorMessage: null, isComputing: false });
  },
  setComputing: (isComputing) => {
    set({ isComputing });
  },
  setError: (errorMessage) => {
    set({ errorMessage, isComputing: false });
  },
  setProjection: (projection) => {
    set({ projection });
  },
  setDisplayStyle: (displayStyle) => {
    set({ displayStyle });
  },
  setShowGrid: (showGrid) => {
    set({ showGrid });
  },
  requestHomeView: () => {
    set((state) => ({ homeViewRequestCount: state.homeViewRequestCount + 1 }));
  },
}));
