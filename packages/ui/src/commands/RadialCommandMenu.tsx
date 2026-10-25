import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { selectedPointsConnection } from '../sketch/connectSelectedPoints.js';
import { selectedPointsFace } from '../sketch/faceSelectedPoints.js';
import { pointAtReferenceShownInMenu } from '../sketch/pointAtReferenceMenu.js';
import { pointAtReferenceDecision } from '../sketch/pointAtReferencePoint.js';
import { pointSelectionCount } from '../sketch/selectedPointEnds.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import { commandDefinition } from './commandDefinitions.js';
import { currentCommandLabel } from './commandLabels.js';
import { executeCommand } from './commandRegistry.js';
import { attachRadialMenuGesture } from './attachRadialMenuGesture.js';
import { radialCommandIds, radialCommandDescription } from './radialCommandItems.js';
import type { RadialMenuGesture } from './radialMenuGesture.js';
import type { RadialMenuSlot } from './radialMenuGeometry.js';
import './radialMenu.css';

const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
function documentOwner(): object {
  const state = useAppStore.getState();
  return state.drawing ?? state.assembly ?? state.document;
}
function blocked(): boolean {
  const state = useAppStore.getState();
  return state.isComputing || state.drawingBusy || state.helpTopicId !== null
    || state.importUnitAsked || document.querySelector('dialog[open], [aria-modal="true"]') !== null;
}

/** One temporary overlay for the drawing surface; it owns no model or Undo state. */
export function RadialCommandMenu({ viewport }: { readonly viewport: RefObject<HTMLDivElement | null> }): React.JSX.Element | null {
  const kind = useAppStore(state => activeDocumentKind(state));
  const assignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const connectionReason = useAppStore(state => selectedPointsConnection(state).reasonKey);
  const faceReason = useAppStore(state => selectedPointsFace(state).reasonKey);
  const pointAtReferenceReason = useAppStore(state => pointAtReferenceDecision(state).reasonKey);
  const pointCount = useAppStore(state => pointSelectionCount(state));
  const [shown, setShown] = useState<{ readonly gesture: RadialMenuGesture; readonly latched: boolean } | null>(null);
  const [focusedSlot, setFocusedSlot] = useState<RadialMenuSlot | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const control = useRef<ReturnType<typeof attachRadialMenuGesture> | null>(null);
  const shownIds = useRef(radialCommandIds(kind));
  useEffect(() => {
    const parent = viewport.current;
    if (parent === null) return;
    let surface: HTMLElement | SVGElement | null = null;
    const connect = (): void => {
      const candidate = parent.querySelector('.pcad-viewport__canvas, .pcad-drawing-svg');
      const next = candidate instanceof HTMLElement || candidate instanceof SVGElement ? candidate : null;
      if (surface === next) return;
      control.current?.detach(); control.current = null; surface = next;
      if (next === null) return;
      control.current = attachRadialMenuGesture(next, {
        owner: documentOwner, blocked,
        clickOnly: next.matches('.pcad-viewport__canvas'),
        allowSelectionModifiers: () => selectedPointsConnection().ready || selectedPointsFace().ready,
        scale: () => useAppStore.getState().displaySettings.uiScale / 100,
        nativeClickTarget: target => target instanceof Node && menu.current?.contains(target) === true,
        clickSlot: point => {
          const button = document.elementFromPoint(point.x, point.y)?.closest('.pcad-radial-menu__item');
          return SLOTS.find(slot => button?.getAttribute('data-radial-slot') === String(slot)) ?? null;
        },
        show: (gesture, latched = false, preserveFocus = false) => {
          if (gesture !== null) {
            shownIds.current = radialCommandIds(kind, selectedPointsConnection().showInMenu, selectedPointsFace().showInMenu,
              pointAtReferenceShownInMenu());
          }
          if (!preserveFocus) setFocusedSlot(null);
          setShown(gesture === null ? null : { gesture, latched });
        },
        choose: (slot) => {
          const currentKind = activeDocumentKind(useAppStore.getState());
          if (currentKind !== kind) return;
          executeCommand(shownIds.current[slot]);
        },
      });
    };
    connect();
    const observer = new MutationObserver(connect);
    observer.observe(parent, { subtree: true, childList: true });
    let owner = documentOwner(), uiScale = useAppStore.getState().displaySettings.uiScale;
    let selection = useAppStore.getState().selection;
    const unsubscribe = useAppStore.subscribe(() => {
      const nextOwner = documentOwner();
      const nextScale = useAppStore.getState().displaySettings.uiScale;
      const nextSelection = useAppStore.getState().selection;
      if (nextOwner !== owner || blocked() || nextScale !== uiScale || nextSelection !== selection) control.current?.cancel();
      owner = nextOwner; uiScale = nextScale;
      selection = nextSelection;
    });
    return () => { observer.disconnect(); unsubscribe(); control.current?.detach(); control.current = null; };
  }, [kind, viewport]);
  const latched = shown?.latched === true;
  useLayoutEffect(() => {
    if (shown === null || menu.current === null) return;
    const rects = [menu.current, ...Array.from(menu.current.children)].map(element => element.getBoundingClientRect());
    const left = Math.min(...rects.map(rect => rect.left)), top = Math.min(...rects.map(rect => rect.top));
    control.current?.fit({ left, top, width: Math.max(...rects.map(rect => rect.right)) - left,
      height: Math.max(...rects.map(rect => rect.bottom)) - top });
  }, [shown, focusedSlot, connectionReason, faceReason, pointAtReferenceReason, pointCount]);
  useEffect(() => { if (latched) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }, [latched]);
  if (shown === null) return null;
  const { geometry, selected, armed } = shown.gesture;
  const scale = geometry.outerRadius / 152;
  const ids = shownIds.current;
  const unavailableReason = (slot: RadialMenuSlot): MessageKey | null => ids[slot] === 'sketch.connectPoints'
    ? connectionReason : ids[slot] === 'sketch.faceFromPoints' ? faceReason
      : ids[slot] === 'sketch.pointAtReference' ? pointAtReferenceReason : null;
  // The selected point count is shown with the reason or the hint, e.g. "1/2" for the connection.
  const countText = (slot: RadialMenuSlot): string => ids[slot] === 'sketch.connectPoints'
    ? t('sketch.connect.count').replace('{count}', String(pointCount))
    : ids[slot] === 'sketch.faceFromPoints' ? t('sketch.facePoints.count').replace('{count}', String(pointCount)) : '';
  const description = (slot: RadialMenuSlot): string => {
    const reason = unavailableReason(slot);
    return countText(slot) + (reason !== null ? t(reason) : radialCommandDescription(ids[slot]));
  };
  const explainedSlot = (latched ? focusedSlot : null) ?? selected;
  const explanation = explainedSlot === null ? null
    : currentCommandLabel(ids[explainedSlot], assignments, kind) + ': ' + description(explainedSlot);
  const choose = (slot: RadialMenuSlot): void => { control.current?.choose(slot); };
  return <div ref={menu} className="pcad-radial-menu" role="menu" aria-label={t('radial.title')}
    data-help-topic="radial-menu" aria-describedby="pcad-radial-hint"
    style={{ left: geometry.center.x - geometry.outerRadius, top: geometry.center.y - geometry.outerRadius,
      width: geometry.outerRadius * 2, height: geometry.outerRadius * 2, fontSize: 12 * scale }}
    onKeyDown={event => {
      const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      const index = event.target instanceof HTMLButtonElement ? buttons.indexOf(event.target) : -1;
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % buttons.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
      if (next !== null) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
    }}>
    {SLOTS.map(slot => {
      const id = ids[slot], definition = commandDefinition(id);
      if (definition === null) return null;
      const angle = slot * Math.PI / 4, radius = geometry.outerRadius * 0.72;
      return <button key={id} type="button" role="menuitem" className="pcad-radial-menu__item"
        data-selected={selected === slot} data-radial-slot={slot} data-command-id={id} data-help-topic={definition.helpTopic}
        title={currentCommandLabel(id, assignments, kind) + ': ' + description(slot)}
        aria-disabled={unavailableReason(slot) !== null ? true : undefined}
        aria-describedby="pcad-radial-hint" onFocus={() => setFocusedSlot(slot)} onBlur={() => setFocusedSlot(null)}
        style={{ left: geometry.outerRadius + Math.sin(angle) * radius,
          top: geometry.outerRadius - Math.cos(angle) * radius,
          width: 74 * scale, minHeight: 42 * scale, padding: 4 * scale }}
        onClick={() => choose(slot)}>
        {t(definition.labelKey)}
      </button>;
    })}
    <button type="button" className="pcad-radial-menu__cancel" title={t('radial.cancelHint')}
      style={{ width: 58 * scale, height: 58 * scale }}
      onClick={() => control.current?.cancel()}>{t('radial.cancel')}</button>
    <p id="pcad-radial-hint" className="pcad-radial-menu__hint">{explanation ?? t(latched ? 'radial.clickHint' : !armed ? 'radial.enterCentre' : 'radial.dragHint')}</p>
  </div>;
}
