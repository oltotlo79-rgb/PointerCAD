import { appendSolid, DEFAULT_WORK_PLANE_ID, FREE_WORK_PLANE_ID, type SolidBody } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { subShapeElementId } from '../../solid/subShapeSelection.js';
import { bodyFor, extrudeFeature, partWithPoint, resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { activateShapeTool, activateTool } from './sketchToolActions.js';

const TOP_FACE = subShapeElementId('extrude-1', 'face', 0);
const WALL_FACE = subShapeElementId('extrude-1', 'face', 1);

/** 押し出し 1 段の板の上面(平ら、高さ 10)か穴の壁(円柱)を、選ぶ種類「面」で 1 枚選ぶ。 */
function selectFace(face: string): void {
  const body: SolidBody = {
    ...bodyFor('extrude-1'),
    faces: [
      { index: 0, surfaceKind: 'plane', area: 1200, centroid: [20, 15, 10], axis: [0, 0, 1], radius: null,
        triangleOffset: 0, triangleCount: 1 },
      { index: 1, surfaceKind: 'cylinder', area: 180, centroid: [20, 15, 5], axis: [0, 0, 1], radius: 3,
        triangleOffset: 0, triangleCount: 1 },
    ],
  };
  useAppStore.setState({ bodies: [body], selectionKind: 'face', selection: [face], isComputing: false });
}

beforeEach(() => {
  resetTestStore();
  useAppStore.getState().resetDocument(appendSolid(partWithPoint(), extrudeFeature('extrude-1')));
});

describe('平らな面を選んでから描く道具を押すと、その面を作図面にする(M-18 面に直接かく)', () => {
  it('線分: 面の作業平面を作って作図面にし、帯で知らせ、元に戻す 1 回で消えて XY へ戻る', () => {
    selectFace(TOP_FACE);
    activateTool('line', false);
    const state = useAppStore.getState();
    expect(state.document.references).toHaveLength(1);
    const plane = state.document.references[0];
    expect(plane.kind === 'referencePlane' ? plane.plane.kind : null).toBe('face');
    expect(state.workPlaneId).toBe(plane.id);
    expect(state.workPlane.origin[2]).toBeCloseTo(10, 9);
    expect(state.editNoticeKey).toBe('sketch.faceWorkPlane.chosen');
    expect(state.activeTool).toBe('line');
    expect(state.numericInput?.toolId).toBe('line');

    useAppStore.getState().undo();
    expect(useAppStore.getState().document.references).toHaveLength(0);
    expect(useAppStore.getState().workPlaneId).toBe(DEFAULT_WORK_PLANE_ID);
  });

  it('作図の図形でも同じで、同じ面の作業平面があれば作らずに使い直し、もうその面なら何もしない', () => {
    selectFace(TOP_FACE);
    activateShapeTool('rectangle', false);
    const first = useAppStore.getState();
    expect(first.document.references).toHaveLength(1);
    expect(first.workPlaneId).toBe(first.document.references[0].id);
    expect(first.numericInput?.toolId).toBe('rectangle');

    useAppStore.getState().setWorkPlane(DEFAULT_WORK_PLANE_ID);
    selectFace(TOP_FACE);
    activateTool('point', false);
    const second = useAppStore.getState();
    expect(second.document).toBe(first.document);
    expect(second.workPlaneId).toBe(first.workPlaneId);
    expect(second.editNoticeKey).toBe('sketch.faceWorkPlane.chosen');

    selectFace(TOP_FACE);
    activateTool('arc', false);
    expect(useAppStore.getState().document).toBe(first.document);
    expect(useAppStore.getState().workPlaneId).toBe(first.workPlaneId);
    expect(useAppStore.getState().editNoticeKey).toBeNull();
  });

  it('曲面・選択の道具・面を張る道具・3D スケッチでは作図面を変えない', () => {
    selectFace(WALL_FACE);
    activateTool('line', false);
    expect(useAppStore.getState().document.references).toHaveLength(0);
    expect(useAppStore.getState().workPlaneId).toBe(DEFAULT_WORK_PLANE_ID);

    for (const tool of ['select', 'face'] as const) {
      selectFace(TOP_FACE);
      activateTool(tool, false);
      expect(useAppStore.getState().document.references).toHaveLength(0);
      expect(useAppStore.getState().workPlaneId).toBe(DEFAULT_WORK_PLANE_ID);
    }

    useAppStore.getState().setWorkPlane(FREE_WORK_PLANE_ID);
    selectFace(TOP_FACE);
    activateTool('line', false);
    expect(useAppStore.getState().document.references).toHaveLength(0);
    expect(useAppStore.getState().workPlaneId).toBe(FREE_WORK_PLANE_ID);
    expect(useAppStore.getState().editNoticeKey).toBeNull();
  });
});
