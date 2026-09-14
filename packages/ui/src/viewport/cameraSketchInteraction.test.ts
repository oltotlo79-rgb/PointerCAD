import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { attachCameraControls } from './attachCameraControls.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import type { ViewportScene } from './createViewportScene.js';

afterEach(() => vi.unstubAllGlobals());

describe('視点を動かす間の作図入力の所有権', () => {
  it.each([
    { name: '中ボタンの回転', button: 1, shiftKey: false, altKey: false },
    { name: '中ボタンの平行移動', button: 1, shiftKey: true, altKey: false },
    { name: 'Altと左ボタンの回転', button: 0, shiftKey: false, altKey: true },
    { name: 'Altと左ボタンの平行移動', button: 0, shiftKey: true, altKey: true },
  ].flatMap(mode => ['pointerup', 'pointercancel', 'lostpointercapture'].map(end => ({ ...mode, end }))))(
    '$nameでは吸着を繰り返さず、$end後は同じ文書で再開する', mode => {
      resetTestStore();
      useAppStore.setState({ activeTool: 'select', selectionKind: 'body', snapEnabled: true, snapKinds: ['grid'] });
      const captured = new Set<number>();
      const canvas = Object.assign(new EventTarget(), {
        clientHeight: 600,
        getBoundingClientRect: () => ({ left: 0, top: 0 }),
        setPointerCapture: (id: number) => { captured.add(id); },
        hasPointerCapture: (id: number) => captured.has(id),
        releasePointerCapture: (id: number) => { captured.delete(id); },
        focus: vi.fn(),
      }) as unknown as HTMLCanvasElement;
      const project = vi.fn((point: readonly [number, number, number]) => [point[0], point[1]] as const);
      const scene = {
        worldToScreen: project,
        screenToPlanePoint: (x: number, y: number) => [x, y, 0] as const,
      } as unknown as ViewportScene;
      const controls = attachCameraControls(canvas, () => {});
      const sketch = attachSketchInteraction(canvas, scene, () => controls.getOrbit(), () => controls.isDragging());
      const send = (type: string, props: object = {}): void => {
        canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
          pointerId: 1, button: 0, buttons: 0, clientX: 0, clientY: 0, altKey: false, shiftKey: false, ...props,
        }));
      };
      let updates = 0;
      const unsubscribe = useAppStore.subscribe(() => { updates++; });
      try {
        send('pointermove');
        expect(useAppStore.getState().snapIndicator?.kind).toBe('grid');
        const before = useAppStore.getState(), orbit = controls.getOrbit();
        send('pointerdown', mode);
        send('pointermove', { clientX: 10, clientY: 10 });
        expect(useAppStore.getState().snapIndicator).toBeNull();
        const clearedUpdates = updates;
        project.mockClear();
        // Altを途中で離しても視点操作を続け、作図や画面への更新を増やさない。
        for (let i = 0; i < 100; i++) send('pointermove', { clientX: 20 + i, clientY: 30 + i });
        expect(controls.getOrbit()).not.toEqual(orbit);
        expect(project).not.toHaveBeenCalled();
        expect(updates).toBe(clearedUpdates);
        expect(useAppStore.getState().document).toBe(before.document);
        expect(useAppStore.getState().requestedGeneration).toBe(before.requestedGeneration);
        expect(useAppStore.getState().selection).toBe(before.selection);
        send(mode.end);
        send('pointermove');
        expect(useAppStore.getState().snapIndicator?.kind).toBe('grid');
        expect(project).toHaveBeenCalled();
      } finally { unsubscribe(); sketch.detach(); controls.detach(); }
    },
  );
});
