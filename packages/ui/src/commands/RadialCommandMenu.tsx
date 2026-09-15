import { useEffect, useRef, useState, type RefObject } from 'react';
import { t } from '../i18n/t.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import { commandDefinition } from './commandDefinitions.js';
import { currentCommandLabel } from './commandLabels.js';
import { executeCommand } from './commandRegistry.js';
import { attachRadialMenuGesture } from './attachRadialMenuGesture.js';
import { radialCommandAt, radialCommandIds, radialCommandDescription } from './radialCommandItems.js';
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
  const [shown, setShown] = useState<{ readonly gesture: RadialMenuGesture; readonly latched: boolean } | null>(null);
  const [focusedSlot, setFocusedSlot] = useState<RadialMenuSlot | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const control = useRef<ReturnType<typeof attachRadialMenuGesture> | null>(null);
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
        scale: () => useAppStore.getState().displaySettings.uiScale / 100,
        nativeClickTarget: target => target instanceof Node && menu.current?.contains(target) === true,
        clickSlot: point => {
          const button = document.elementFromPoint(point.x, point.y)?.closest('.pcad-radial-menu__item');
          return SLOTS.find(slot => button?.getAttribute('data-radial-slot') === String(slot)) ?? null;
        },
        show: (gesture, latched = false) => {
          setFocusedSlot(null); setShown(gesture === null ? null : { gesture, latched });
        },
        choose: (slot) => {
          const currentKind = activeDocumentKind(useAppStore.getState());
          if (currentKind !== kind) return;
          const id = radialCommandAt(kind, slot);
          if (id !== null && executeCommand(id).status === 'disabled') {
            useAppStore.getState().setError(t('radial.unavailable'));
          }
        },
      });
    };
    connect();
    const observer = new MutationObserver(connect);
    observer.observe(parent, { subtree: true, childList: true });
    let owner = documentOwner(), uiScale = useAppStore.getState().displaySettings.uiScale;
    const unsubscribe = useAppStore.subscribe(() => {
      const nextOwner = documentOwner();
      const nextScale = useAppStore.getState().displaySettings.uiScale;
      if (nextOwner !== owner || blocked() || nextScale !== uiScale) control.current?.cancel();
      owner = nextOwner; uiScale = nextScale;
    });
    return () => { observer.disconnect(); unsubscribe(); control.current?.detach(); control.current = null; };
  }, [kind, viewport]);
  const latched = shown?.latched === true;
  useEffect(() => { if (latched) menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus(); }, [latched]);
  if (shown === null) return null;
  const { geometry, selected, armed } = shown.gesture;
  const scale = geometry.outerRadius / 152;
  const ids = radialCommandIds(kind);
  const explainedSlot = (latched ? focusedSlot : null) ?? selected;
  const explanation = explainedSlot === null ? null
    : currentCommandLabel(ids[explainedSlot], assignments, kind) + ': ' + radialCommandDescription(ids[explainedSlot]);
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
        title={currentCommandLabel(id, assignments, kind) + ': ' + radialCommandDescription(id)}
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
