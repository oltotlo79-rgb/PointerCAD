import { collectVariables, resolveSketch, WORK_PLANES } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { submitCommandLine } from '../shell/commandLineActions.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrag, draggableAt, isDraggable, solveWithDrag } from '../viewport/dragSketch.js';
import { pickSketchDragTarget } from '../viewport/pickSketchDragTarget.js';
import { commitTrim } from './editCommands.js';
import { trimPreviewAt } from './trimPreview.js';
import { toggleNumericInput } from './numericInput.js';

beforeEach(() => { useAppStore.setState({ ...createInitialDocumentState(), viewportSize: [1200, 800] }); });
function draw(from: string, to: string): void {
  useAppStore.getState().setActiveTool('select');
  expect(submitCommandLine('L')).toMatchObject({ kind: 'tool' });
  expect(submitCommandLine(from)).toEqual({ kind: 'committed' });
  expect(submitCommandLine(to)).toEqual({ kind: 'committed' });
}

describe('交点の自動接続・編集の操作', () => {
  it('極座標で交差させると自動で4区間になり、Undo1回で元の1本へ戻る', () => {
    draw('-10,0', '@20<0');
    const before = useAppStore.getState().sketch;
    draw('0,-10', '@20<90');
    expect(resolveSketch(useAppStore.getState().sketch).segments).toHaveLength(4);
    useAppStore.getState().undo();
    expect(useAppStore.getState().sketch).toEqual(before);
    useAppStore.getState().redo();
    expect(resolveSketch(useAppStore.getState().sketch).segments).toHaveLength(4);
  });

  it('共有点をドラッグで曲げても外側の端は固定され、離すまで文書は変わらない', () => {
    draw('-10,0', '10,0'); draw('0,-10', '0,10');
    const document = useAppStore.getState().sketch;
    const resolved = resolveSketch(document);
    const point = resolved.points.find((candidate) => candidate.position.every((value) => Math.abs(value) < 1e-8));
    if (point === undefined) throw new Error('missing junction');
    const target = pickSketchDragTarget(resolved, (at) => [at[0] * 10, at[1] * 10], [0, 0]);
    expect(target).toEqual({ kind: 'point', pointId: point.id });
    expect(pickSketchDragTarget(resolved, (at) => [at[0] * 10, at[1] * 10], [8, 0])).toEqual(target);
    if (target === null) throw new Error('junction was not picked');
    const drag = draggableAt(document, collectVariables(document, resolved, WORK_PLANES.xy), target, [0, 0]);
    if (!isDraggable(drag)) throw new Error('junction is not draggable');
    const solution = solveWithDrag(document, drag, [2, 3]);
    expect(useAppStore.getState().sketch).toBe(document);
    const changed = commitDrag(document, drag, solution.solution, solution.resolved, WORK_PLANES.xy);
    const segments = resolveSketch(changed).segments;
    expect(segments.map((segment) => [segment.from, segment.to])).toEqual([
      [[-10, 0, 0], [2, 3, 0]], [[2, 3, 0], [10, 0, 0]],
      [[0, -10, 0], [2, 3, 0]], [[2, 3, 0], [0, 10, 0]],
    ]);
  });

  it('分割済み区間のトリム予告と実際の削除が一致し、Undoで戻る', () => {
    draw('-10,0', '10,0'); draw('0,-10', '0,10');
    const document = useAppStore.getState().sketch, resolved = resolveSketch(document);
    const segment = resolved.segments[0];
    expect(trimPreviewAt(resolved, segment.featureId, [-5, 0, 0])).toEqual({
      ok: true, preview: { kind: 'trim', points: [segment.from, segment.to] },
    });
    const result = commitTrim(document, segment.featureId, [-5, 0, 0]);
    if (!result.ok) throw new Error(result.reasonKey);
    useAppStore.getState().setSketch(result.document);
    expect(resolveSketch(useAppStore.getState().sketch).segments).toHaveLength(3);
    useAppStore.getState().undo(); expect(useAppStore.getState().sketch).toEqual(document);
  });

  it('交点でつなぐを切れば交差した2本をそのまま残せる', () => {
    draw('-10,0', '10,0');
    useAppStore.getState().setActiveTool('select'); submitCommandLine('L'); submitCommandLine('0,-10');
    const input = useAppStore.getState().numericInput;
    if (input === null) throw new Error('missing input');
    useAppStore.setState({ numericInput: toggleNumericInput(input, 'splitIntersections') });
    expect(submitCommandLine('0,10')).toEqual({ kind: 'committed' });
    expect(resolveSketch(useAppStore.getState().sketch).segments).toHaveLength(2);
    expect(resolveSketch(useAppStore.getState().sketch).points).toHaveLength(0);
    expect(useAppStore.getState().numericInput?.toggles.find((toggle) => toggle.key === 'splitIntersections')?.value).toBe(false);
  });
});
