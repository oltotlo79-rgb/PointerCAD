import React, { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentStagedSolid } from '../store/recomputeSlice.js';
import { clampAnchor, NumericInputPopover, popoverMaxHeight } from './NumericInputPopover.js';
import { chooseNumericInput, createNumericInput, reduceNumericInput, SOLID_TOOL_STEPS } from './numericInput.js';
import { exactExpressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { absoluteCoordinate, appendFeature, appendSolid, DEFAULT_FACE_COLOR, replaceSketch, type PartDocument } from '@pointercad/model';
import { attachPartRecompute } from '../store/attachKernel.js';
import { extrudeFeature, resultFor, tick } from '../store/testing/createTestStore.js';
import { confirmExtrusion } from '../solid/extrudePreview.js';
import { withExtrudeSuggestions } from '../solid/extrudeSuggestion.js';
import { NumericMathDialog } from './NumericMathDialog.js';
import { EdgeDistanceHoleInfo } from './EdgeDistanceHoleInfo.js';
import { distanceHandleScreenRect } from '../viewport/distanceHandleScreenRect.js';
import { HANDLE_PICK_RADIUS_PIXELS } from '../viewport/sectionHandleDrag.js';

interface KeyInput {
  readonly key: string;
  readonly nativeEvent: Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing'>;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}
interface NodeProps { readonly children?: ReactNode; readonly role?: string; readonly onKeyDown?: (event: KeyInput) => void }

function keyInput(key: string, shiftKey = false): KeyInput {
  return { key, nativeEvent: { key, keyCode: 0, isComposing: false }, shiftKey, ctrlKey: key === 'z',
    metaKey: false, altKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

function renderPanelProbe(render: (panel: ReactElement<NodeProps>) => ReactNode): string {
  function Probe(): ReactNode {
    const tree: ReactElement<NodeProps> | null = NumericInputPopover({ viewportWidth: 800, viewportHeight: 600 });
    let content: ReactNode = null;
    if (tree !== null) {
      Children.forEach(tree.props.children, child => {
        if (isValidElement<NodeProps>(child) && child.props.role === 'dialog') content = render(child);
      });
    }
    return content;
  }
  return renderToStaticMarkup(<Probe />);
}

function panelHandler(): (event: KeyInput) => void {
  let handler: NodeProps['onKeyDown'];
  renderPanelProbe(panel => { handler = panel.props.onKeyDown; return null; });
  if (handler === undefined) throw new Error('NumericInputPopover handler missing');
  return handler;
}

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  const input = reduceNumericInput(createNumericInput('point', 'point', 'absolute'), { type: 'edit', index: 0, source: '10*2' });
  useAppStore.setState({ activeTool: 'point', numericInput: input, numericInputAnchor: [100, 100] });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('NumericInputPopover real React handler and store (node, not DOM)', () => {
  it('rejects 100 late numeric-math apply callbacks after cancel without document/Undo/draft changes', async () => {
    const before = useAppStore.getState();
    if (before.numericInput === null) throw new Error('numeric draft missing');
    const tree = NumericMathDialog({ target: { document: before.document, documentVersion: before.documentVersion,
      input: before.numericInput, index: 0, lengthUnit: 'mm' }, onClose: vi.fn() });
    interface ApplyProps {
      readonly onApply: (value: ExpressionValue, prepared: PartDocument, signal: AbortSignal) => Promise<{ readonly ok: boolean }>;
    }
    if (!isValidElement<ApplyProps>(tree)) throw new Error('math callback missing');
    before.closeNumericInput(); const cancelled = useAppStore.getState();
    for (let index = 0; index < 100; index++) {
      expect(await tree.props.onApply(exactExpressionValueFromNumber(30), before.document, new AbortController().signal)).toMatchObject({ ok: false });
    }
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(useAppStore.getState().numericInput).toBe(cancelled.numericInput);
  });
  it('normal Enter commits the expression once and one Undo restores the document', () => {
    const before = useAppStore.getState(), event = keyInput('Enter');
    panelHandler()(event);
    const after = useAppStore.getState();
    expect(after.sketch.features).toHaveLength(before.sketch.features.length + 1);
    expect(JSON.stringify(after.sketch.features.at(-1))).toContain('10*2');
    expect(after.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
    after.undo(); expect(useAppStore.getState().document).toBe(before.document);
  });
  it('normal Escape discards only the draft', () => {
    const before = useAppStore.getState(), event = keyInput('Escape'); panelHandler()(event);
    const after = useAppStore.getState();
    expect(after.numericInput).toBeNull(); expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
  it('Tab and ShiftTab move between numeric fields without a document mutation', () => {
    const before = useAppStore.getState(); panelHandler()(keyInput('Tab'));
    expect(useAppStore.getState().numericInput?.focusedIndex).toBe(1);
    panelHandler()(keyInput('Tab', true));
    expect(useAppStore.getState().numericInput?.focusedIndex).toBe(0);
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
  it.each(['Delete', 'Backspace', 'z'])('leaves native text %s to the input owner', key => {
    const before = useAppStore.getState(), event = keyInput(key); panelHandler()(event);
    expect(useAppStore.getState().numericInput).toBe(before.numericInput);
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
  });
  it.each([
    ['Enter', 13, true], ['Escape', 27, true], ['Enter', 229, false], ['Escape', 229, false], ['Process', 0, false],
  ] as const)('preserves draft/document/Undo for %s code %i composing %s', (key, keyCode, isComposing) => {
    const before = useAppStore.getState();
    const preventDefault = vi.fn(); const stopPropagation = vi.fn();
    panelHandler()({ key, nativeEvent: { key, keyCode, isComposing }, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault, stopPropagation });
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.numericInput).toBe(before.numericInput);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });
});

interface CollapseButtonProps {
  readonly onClick: (event: { readonly currentTarget: { readonly focus: () => void } }) => void;
}

function probeEdgeDistance(clicks = 0) {
  let infoKey: string | null | undefined;
  let onKeyDown: NodeProps['onKeyDown'];
  let remaining = clicks;
  const focus = vi.fn();
  function InfoProbe(): ReactElement<NodeProps> {
    const info: ReactElement<NodeProps> = EdgeDistanceHoleInfo();
    if (remaining > 0) {
      const button = Children.toArray(info.props.children).find(node => isValidElement(node) && node.type === 'button');
      if (!isValidElement<CollapseButtonProps>(button)) throw new Error('Edge distance collapse button missing');
      // Node の描画で釦の実際の onClick を呼び、同じ部品の状態を再描画する。
      remaining -= 1;
      button.props.onClick({ currentTarget: { focus } });
    }
    return info;
  }
  const markup = renderPanelProbe(panel => {
    onKeyDown = panel.props.onKeyDown;
    Children.forEach(panel.props.children, child => {
      if (isValidElement(child) && child.type === EdgeDistanceHoleInfo) infoKey = child.key;
    });
    return infoKey === undefined ? null : <InfoProbe />;
  });
  return { infoKey, markup, onKeyDown, focus };
}

describe('Edge-distance hole input collapse (M-10)', () => {
  beforeEach(() => {
    const input = createNumericInput('hole', 'holeSize', undefined, { initialHolePlacement: 'edge-distance' });
    const values: Readonly<Record<string, string>> = { diameter: '6', depth: '10', holeEdgeDistance1: '8', holeEdgeDistance2: '5' };
    const filled = input.fields.reduce((next, field, index) => {
      const source = values[field.key];
      return source === undefined ? next : reduceNumericInput(next, { type: 'edit', index, source });
    }, input);
    useAppStore.setState({ activeTool: 'hole', numericInput: filled, selection: [], partStager: null });
  });

  it('starts expanded and toggles both ways without changing the numeric draft', () => {
    const before = useAppStore.getState().numericInput;
    expect(probeEdgeDistance().markup).toContain('data-edge-distance-collapsed="false"');
    const collapsed = probeEdgeDistance(1);
    expect(collapsed.markup).toContain('data-edge-distance-collapsed="true"');
    expect(collapsed.markup).toContain('aria-expanded="false"');
    expect(collapsed.markup).toContain(t('numericInput.edgeDistance.edge2'));
    expect(collapsed.markup).toContain(t('numericInput.edgeDistance.expand'));
    expect(collapsed.markup).toContain(t('controlGuide.button.numericEdgeDistanceExpand'));
    expect(collapsed.focus).toHaveBeenCalledOnce();
    const expanded = probeEdgeDistance(2);
    expect(expanded.markup).toContain('data-edge-distance-collapsed="false"');
    expect(expanded.markup).toContain('aria-expanded="true"');
    expect(expanded.markup).toContain(t('numericInput.edgeDistance.collapse'));
    expect(expanded.markup).toContain(t('controlGuide.button.numericEdgeDistanceCollapse'));
    expect(useAppStore.getState().numericInput).toBe(before);
  });

  it('starts expanded for a new stage and unmounts when placement changes', () => {
    const collapsed = probeEdgeDistance(1);
    expect(collapsed.infoKey).toBe('hole:holeSize');
    expect(collapsed.markup).toContain('data-edge-distance-collapsed="true"');
    const next = createNumericInput('threadHole', 'threadSize', undefined, { initialHolePlacement: 'edge-distance' });
    useAppStore.setState({ activeTool: 'threadHole', numericInput: next });
    const reopened = probeEdgeDistance();
    expect(reopened.infoKey).toBe('threadHole:threadSize');
    expect(reopened.markup).toContain('aria-expanded="true"');
    useAppStore.setState({ numericInput: chooseNumericInput(next, 'holePlacement', 'plane-face') });
    expect(probeEdgeDistance().infoKey).toBeUndefined();
    useAppStore.setState({ numericInput: next });
    expect(probeEdgeDistance().markup).toContain('aria-expanded="true"');
  });

  it('routes Enter to hole confirmation and Escape to cancel while collapsed', () => {
    const before = useAppStore.getState();
    const { markup, onKeyDown } = probeEdgeDistance(1);
    expect(markup).toContain('aria-expanded="false"');
    if (onKeyDown === undefined) throw new Error('NumericInputPopover handler missing');
    const enter = keyInput('Enter');
    onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    // 面を選んでいないので、穴の確定処理まで届いたときだけこの理由が出る。
    expect(useAppStore.getState().solidErrorKey).toBe('machiningError.noFace');
    expect(useAppStore.getState().numericInput).not.toBeNull();
    const escape = keyInput('Escape');
    onKeyDown(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(useAppStore.getState().numericInput).toBeNull();
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
});

describe('Extrusion input commits through geometry calculation (EX-14)', () => {
  beforeEach(() => {
    useAppStore.setState({ activeTool: 'extrude', numericInput: createNumericInput('extrude', 'extrudeDistance'),
      numericInputAnchor: [100, 100], partStager: null, stagedSolid: null });
  });

  it.each(['extrude', 'revolve', 'sphere', 'box', 'cylinder', 'cone', 'torus'] as const)(
    '%s shows the localized preview action', tool => {
      useAppStore.setState({ activeTool: tool, numericInput: createNumericInput(tool, SOLID_TOOL_STEPS[tool]) });
      expect(renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />))
        .toContain(t('numericInput.extrudePreview'));
    });
  it.each([['sweep', 'sweepOptions'], ['loft', 'loftTwist'], ['ruled', 'ruledTwist']] as const)(
    '%s at %s offers preview before committing (M-03)', (tool, step) => {
      useAppStore.setState({ activeTool: tool, numericInput: createNumericInput(tool, step) });
      const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
      expect(markup).toContain(`>${t('numericInput.extrudePreview')}</button>`);
      expect(markup).toContain(`>${t('numericInput.commit')}</button>`);
      expect(markup).toContain(`>${t('numericInput.cancel')}</button>`);
    });

  it('point keeps commit and cancel without a solid preview action', () => {
    useAppStore.setState({ activeTool: 'point', numericInput: createNumericInput('point', 'point', 'absolute') });
    const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
    expect(markup).not.toContain(`>${t('numericInput.extrudePreview')}</button>`);
    expect(markup).toContain(`>${t('numericInput.commit')}</button>`);
    expect(markup).toContain(`>${t('numericInput.cancel')}</button>`);
  });

  it('extrude with two selected sketch faces keeps commit and cancel without a preview action', () => {
    const { document, sketch } = useAppStore.getState();
    const selection = ['face-1', 'face-2'];
    const twoFaces = selection.reduce((current, id, index) => {
      const rectangleId = `rect-${id}`;
      const x = index * 20;
      const outline = appendFeature(current, {
        id: rectangleId, name: rectangleId, kind: 'rectangle', planeId: 'xy', construction: false,
        corner1: absoluteCoordinate(x, 0, 0), corner2: absoluteCoordinate(x + 10, 10, 0),
      });
      return appendFeature(outline, {
        id, name: id, kind: 'face', planeId: 'xy', color: DEFAULT_FACE_COLOR, boundary: [{ featureId: rectangleId }],
      });
    }, sketch);
    useAppStore.setState({ document: replaceSketch(document, twoFaces), selection, activeTool: 'extrude',
      numericInput: createNumericInput('extrude', 'extrudeDistance') });
    const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
    expect(markup).not.toContain(`>${t('numericInput.extrudePreview')}</button>`);
    expect(markup).toContain(`>${t('numericInput.commit')}</button>`);
    expect(markup).toContain(`>${t('numericInput.cancel')}</button>`);
  });

  it('shows the suggestion badge and its reason beside suggested choices, and drops them after a manual choice (M-01)', () => {
    const suggested = withExtrudeSuggestions(
      createNumericInput('extrude', 'extrudeDistance', undefined, { extrudeTargets: [{ value: 'extrude-1', label: '箱1' }] }),
      { forward: { operation: 'cut', target: 'extrude-1' }, reverse: { operation: 'join', target: 'extrude-1' },
        symmetric: { operation: 'join', target: 'extrude-1' } });
    useAppStore.setState({ numericInput: suggested });
    const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
    // 札は結果と相手の 2 つ(理由の文にも「提案」の字があるので、札の説明の数で数える)。
    expect(markup.split(t('numericInput.extrudeSuggestion.badgeTooltip')).length - 1).toBe(2);
    expect(markup).toContain(t('numericInput.extrudeSuggestion.cut').replace('{name}', '箱1'));
    useAppStore.setState({ numericInput: chooseNumericInput(suggested, 'extrudeOperation', 'new') });
    const manual = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
    expect(manual).not.toContain(t('numericInput.extrudeSuggestion.badgeTooltip'));
    expect(manual).not.toContain(t('numericInput.extrudeSuggestion.cut').replace('{name}', '箱1'));
  });

  it('Alt+P previews through the same path without touching the document, Undo or the open input', () => {
    const before = useAppStore.getState();
    const event = { ...keyInput('p'), code: 'KeyP', altKey: true };
    panelHandler()(event);
    const after = useAppStore.getState();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(after.numericInput).toBe(before.numericInput);
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.solidErrorKey).toBe('solidError.extrudeUnavailable');
    expect(t('numericInput.extrudePreviewTooltip')).toContain('Alt+P');
  });

  it.each([[136, 100], [240, 200], [300, 280], [480, 470], [800, 760]])(
    'keeps every control inside a %ipx-high viewport by scrolling inside the input (anchor y=%i)', (viewportHeight, anchorY) => {
      const position = clampAnchor([100, anchorY], 800, viewportHeight);
      const maxHeight = popoverMaxHeight(position.top, viewportHeight);
      expect(position.top + maxHeight).toBeLessThanOrEqual(viewportHeight - 8);
      expect(maxHeight).toBeGreaterThanOrEqual(120);
      useAppStore.setState({ numericInputAnchor: [100, anchorY] });
      const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={viewportHeight} />);
      expect(markup).toContain(`max-height:${String(maxHeight)}px`);
      expect(markup).toContain('overflow-y:auto');
      for (const label of [t('numericInput.extrudePreview'), t('numericInput.commit'), t('numericInput.cancel')]) {
        expect(markup).toContain(label);
      }
    });

  /* 窓が選んだ面の画面の外形(箱)を避ける(M-10 ①)。窓は 260×372、縁 8、箱から 14 離す。画面は 800×600。 */
  it.each([
    ['anchor', [400, 100], null, 414, 114],
    ['right', [400, 100], { left: 300, top: 50, right: 450, bottom: 200 }, 464, 114],
    ['left', [400, 100], { left: 300, top: 50, right: 600, bottom: 200 }, 26, 114],
    ['below', [400, 100], { left: 20, top: 10, right: 700, bottom: 150 }, 414, 164],
    ['above', [400, 500], { left: 20, top: 450, right: 700, bottom: 590 }, 414, 64],
    ['unplaced', [400, 300], { left: 10, top: 10, right: 790, bottom: 590 }, 414, 220],
  ] as const)('opens %s of the picked face outline without covering it', (placement, anchor, avoid, left, top) => {
    useAppStore.setState({ numericInputAnchor: anchor, numericInputAvoid: avoid });
    const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
    expect(markup).toContain(`data-placement="${placement}"`);
    expect(markup).toContain(`left:${String(left)}px;top:${String(top)}px`);
  });

  /*
   * 押し出しのつまみの外形を避ける(M-05 4-2b)。e2e の extrude-operation.spec.ts:59 と同じ形をホーム視点・画面 920×803 で
   * 写した点(根もと (567, 410)・先端 (571, 374))から、ビューポートと同じ distanceHandleScreenRect で箱を作る。
   * 窓は箱の右(左端 603)に開き、先端の掴める範囲(571 ± 18)を覆わない。
   */
  it('opens right of the extrude handle outline without covering the grip', () => {
    const avoid = distanceHandleScreenRect({ base: [567, 410, 0], origin: [571, 374, 0] }, (point) => [point[0], point[1]]);
    useAppStore.setState({ numericInputAnchor: [460, 402], numericInputAvoid: avoid });
    const markup = renderToStaticMarkup(<NumericInputPopover viewportWidth={920} viewportHeight={803} />);
    expect(markup).toContain('data-placement="right"');
    expect(markup).toContain('left:603px;top:416px');
    // 描いた窓の左端が、先端の掴める範囲の右より右にある(窓がつまみを覆わない)。
    const left = Number(/left:(\d+)px/u.exec(markup)?.[1]);
    expect(left).toBeGreaterThan(571 + HANDLE_PICK_RADIUS_PIXELS);
  });

  it('Enter without the geometry scheduler keeps the input, document and Undo, and explains what to do', () => {
    const before = useAppStore.getState(), event = keyInput('Enter');
    panelHandler()(event);
    const after = useAppStore.getState();
    expect(after.numericInput).toBe(before.numericInput);
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.solidErrorKey).toBe('solidError.extrudeUnavailable');
    expect(t('solidError.extrudeUnavailable')).toContain(t('numericInput.commit'));
  });
});

describe('staged direct-edit notices follow the current input owner', () => {
  it.each([
    ['holeTranslate', 'holeTranslateVector'], ['faceRotate', 'faceRotateAngle'], ['faceOffset', 'faceOffsetDistance'],
    ['cut', 'cutPlane'], ['revolve', 'revolveAngle'], ['box', 'boxSize'],
    ['extrude', 'extrudeDistance'],
  ] as const)('%s displays pending then asynchronous refusal without committing', async (tool, step) => {
    useAppStore.getState().setActiveTool(tool);
    useAppStore.getState().openNumericInput(createNumericInput(tool, step), [100, 100]);
    const failures: ((error: Error) => void)[] = [];
    let initial = true;
    const detach = attachPartRecompute((document, options) => {
      if (initial) {
        initial = false;
        return Promise.resolve({ ...resultFor(document), generation: options.generation ?? 0 });
      }
      return new Promise((_resolve, reject) => { failures.push(reject); });
    });
    try {
      await vi.waitFor(() => { expect(useAppStore.getState().isComputing).toBe(false); });
      const before = useAppStore.getState();
      const candidate = appendSolid(before.document, extrudeFeature('candidate'));
      expect(confirmExtrusion({ base: before.document, document: candidate, featureId: 'candidate', inputKey: 'render' })).toBe('pending');
      const markup = () => renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
      expect(markup()).toContain(t(tool === 'extrude' ? 'numericInput.extrudeConfirming' : 'numericInput.directEditConfirming'));
      expect(markup()).toContain('role="status"');
      expect(failures).toHaveLength(1);
      failures[0](new Error('Native refusal detail'));
      await vi.waitFor(() => { expect(useAppStore.getState().stagedSolid?.status).toBe('failed'); });
      expect(markup()).toContain(tool === 'extrude' ? t('solidError.extrudeWorkerBroken') : 'Native refusal detail');
      expect(markup()).toContain('role="alert"');
      expect(useAppStore.getState().document).toBe(before.document);
      expect(useAppStore.getState().undoStack).toBe(before.undoStack);
      const input = useAppStore.getState().numericInput;
      if (input === null) throw new Error('Input must remain open');
      useAppStore.getState().updateNumericInput(tool === 'cut' ? chooseNumericInput(input, 'cutPlaneKind', 'yz')
        : reduceNumericInput(input, { type: 'edit', index: 0, source: '2' }));
      expect(markup()).not.toContain('Native refusal detail');
    } finally { detach(); }
  });

  it('cut ignores a late refusal owned by the preceding document and clears its pending notice', async () => {
    useAppStore.getState().setActiveTool('cut');
    useAppStore.getState().openNumericInput(createNumericInput('cut', 'cutPlane'), [100, 100]);
    const failures: ((error: Error) => void)[] = [];
    let initial = true;
    const detach = attachPartRecompute((document, options) => {
      if (initial) { initial = false; return Promise.resolve({ ...resultFor(document), generation: options.generation ?? 0 }); }
      return new Promise((_resolve, reject) => { failures.push(reject); });
    });
    try {
      await vi.waitFor(() => { expect(useAppStore.getState().isComputing).toBe(false); });
      const before = useAppStore.getState();
      const candidate = appendSolid(before.document, extrudeFeature('candidate'));
      expect(confirmExtrusion({ base: before.document, document: candidate, featureId: 'candidate', inputKey: 'cut-owner' })).toBe('pending');
      const markup = () => renderToStaticMarkup(<NumericInputPopover viewportWidth={800} viewportHeight={600} />);
      expect(markup()).toContain(t('numericInput.directEditConfirming'));
      expect(failures).toHaveLength(1);
      useAppStore.getState().applyDocument({ ...before.document, name: 'new cut owner' }, { opensDocument: true });
      useAppStore.getState().openNumericInput(createNumericInput('cut', 'cutPlane'), [100, 100]);
      const retained = useAppStore.getState();
      expect(retained.activeDocumentId).not.toBe(before.activeDocumentId);
      expect(markup()).not.toContain(t('numericInput.directEditConfirming'));
      failures[0](new Error('Obsolete cut refusal'));
      await tick();
      expect(currentStagedSolid(useAppStore.getState())).toBeNull();
      if (retained.stagedSolid !== null) expect(retained.partStager?.owns(retained.stagedSolid)).toBe(false);
      expect(markup()).not.toContain('Obsolete cut refusal');
      expect(useAppStore.getState().document).toBe(retained.document);
      expect(useAppStore.getState().undoStack).toBe(retained.undoStack);
    } finally { detach(); }
  });
});
