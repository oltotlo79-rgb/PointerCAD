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

  // 動作を変える口はメソッド宣言ではなくプロパティ関数型で書く。メソッド宣言だと
  // useAppStore((state) => state.setX) のように取り出したとき @typescript-eslint/unbound-method
  // に触れるため(計画書 P1 §0.a-0.12)。
  readonly setDocument: (name: string, featureNames: readonly string[]) => void;
  readonly setMesh: (mesh: PartMesh) => void;
  readonly setComputing: (isComputing: boolean) => void;
  readonly setError: (message: string | null) => void;
  readonly setProjection: (projection: ProjectionMode) => void;
  readonly setDisplayStyle: (displayStyle: DisplayStyle) => void;
  readonly setShowGrid: (showGrid: boolean) => void;
  readonly requestHomeView: () => void;
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
