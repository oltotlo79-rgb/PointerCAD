import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CommandId } from '../commands/commandDefinitions.js';
import { currentCommandLabel } from '../commands/commandLabels.js';
import { t, type MessageKey } from '../i18n/t.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { locateGuideAnchor } from './coachDom.js';
import { placeCoachPopover } from './coachTarget.js';
import './coachMark.css';

type Anchor = { readonly kind: 'command'; readonly id: CommandId } | { readonly kind: 'region'; readonly id: string };
interface Props {
  readonly anchor: Anchor;
  readonly message: MessageKey;
  readonly onTargetChange?: (found: boolean) => void;
}

export function CoachMark({ anchor, message, onTargetChange }: Props): React.JSX.Element | null {
  const assignments = useAppStore(state => currentShortcutAssignments(state.displaySettings));
  const documentKind = useAppStore(state => activeDocumentKind(state));
  const noteRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [group, setGroup] = useState<string | null>(null);
  const { kind, id } = anchor;
  useLayoutEffect(() => {
    const note = noteRef.current;
    const ring = ringRef.current;
    if (!note || !ring) return;
    let frame: number | undefined;
    let observed: HTMLElement | null = null;
    let lastFound: boolean | undefined;
    const position = (): void => {
      frame = undefined;
      const target = locateGuideAnchor({ kind, id });
      const element = target?.element ?? null;
      if (observed !== element) {
        if (observed) resize.unobserve(observed);
        if (element) resize.observe(element);
        observed = element;
      }
      const found = target !== null;
      if (found !== lastFound) {
        lastFound = found;
        onTargetChange?.(found);
      }
      setGroup(target?.group ?? null);
      ring.hidden = !found;
      if (!target) {
        note.style.removeProperty('left');
        note.style.removeProperty('top');
        note.style.removeProperty('bottom');
        return;
      }
      const { rect } = target;
      Object.assign(ring.style, { left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px` });
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const box = placeCoachPopover(rect, note.getBoundingClientRect(), viewport);
      Object.assign(note.style, { left: `${box.left}px`, top: `${box.top}px`, bottom: 'auto',
        maxWidth: `min(28rem, ${box.maxWidth}px)`, maxHeight: `${box.maxHeight}px` });
    };
    const schedule = (): void => {
      if (frame === undefined) frame = requestAnimationFrame(position);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(document.documentElement);
    resize.observe(note);
    const mutations = new MutationObserver(records => {
      if (records.some(record => !note.contains(record.target) && record.target !== ring)) schedule();
    });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'data-command-id', 'data-guide-id', 'data-guide-commands'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    position();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [kind, id, onTargetChange]);
  if (typeof document === 'undefined') return null;
  return createPortal(<>
    <div className="pcad-coach-ring" aria-hidden="true" ref={ringRef} hidden />
    <div className="pcad-coach-note" ref={noteRef} role="status">
      {t(message)} {anchor.kind === 'command' ? currentCommandLabel(anchor.id, assignments, documentKind) : null}
      {group ? t('guide.inGroup').replace('{group}', group) : null}
    </div>
  </>, document.body);
}
