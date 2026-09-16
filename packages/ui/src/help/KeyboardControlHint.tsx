import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/useAppStore.js';
import './keyboardControlHint.css';

interface ControlHint {
  readonly control: HTMLElement;
  readonly titleOwner: HTMLElement;
  readonly text: string;
  readonly host: HTMLElement;
}

function controlName(control: HTMLElement, labels: readonly HTMLLabelElement[]): string {
  const references = (control.getAttribute('aria-labelledby') ?? '').split(/\s+/u).filter(Boolean)
    .map(id => control.ownerDocument.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ');
  const labelText = labels.map(label => {
    const copy = label.cloneNode(true);
    if (!(copy instanceof HTMLElement)) return label.textContent?.trim() ?? '';
    // A select's option list is not its field name. Keep only the visible caption.
    for (const child of copy.querySelectorAll('input, select, textarea, button, math-field, [aria-hidden="true"]')) child.remove();
    return copy.textContent?.trim() ?? '';
  }).filter(Boolean).join(' ');
  return references || control.getAttribute('aria-label')?.trim() || labelText || control.textContent?.trim() || '';
}

/** Keyboard users read the same title as mouse users; no second description dictionary is maintained. */
export function KeyboardControlHint(): React.JSX.Element | null {
  const id = useId(), hintElement = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<ControlHint | null>(null);
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | null>(null);
  const scale = useAppStore(state => state.displaySettings.uiScale);
  useEffect(() => {
    let keyboard = false, scheduled = 0, owner: HTMLElement | null = null;
    const clear = (): void => { owner = null; setHint(null); };
    const refresh = (): void => {
      scheduled = 0;
      const active = document.activeElement;
      if (!keyboard || document.hidden || !(active instanceof HTMLElement)) { clear(); return; }
      const labels = active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement
        ? [...(active.labels ?? [])] : [];
      const titleOwner = active.hasAttribute('title') ? active : labels.find(label => label.hasAttribute('title')) ?? null;
      const title = titleOwner?.getAttribute('title')?.trim() ?? '';
      if (titleOwner === null || !active.isConnected || title === '' || active.getClientRects().length === 0) { clear(); return; }
      const control = active;
      const label = controlName(active, labels);
      const text = label === '' || title.includes(label) ? title : `${label}: ${title}`;
      const host = active.closest<HTMLDialogElement>('dialog[open]') ?? document.body;
      owner = control;
      setHint(previous => previous?.control === control && previous.titleOwner === titleOwner && previous.text === text && previous.host === host
        ? previous : { control, titleOwner, text, host });
    };
    const schedule = (): void => { if (!scheduled) scheduled = requestAnimationFrame(refresh); };
    const keydown = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { keyboard = false; clear(); return; }
      if (['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        keyboard = true; schedule();
      }
    };
    const pointer = (): void => { keyboard = false; clear(); };
    const blur = (): void => { keyboard = false; clear(); };
    const observer = new MutationObserver(records => {
      // The update returns the same hint object when text/owner are unchanged, including changes caused by the tooltip itself.
      if (owner !== null && records.length > 0) schedule();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label', 'aria-labelledby', 'hidden'] });
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('focusin', schedule, true);
    document.addEventListener('focusout', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('blur', blur);
    return () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      observer.disconnect();
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('focusin', schedule, true);
      document.removeEventListener('focusout', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('blur', blur);
    };
  }, []);
  useEffect(() => {
    if (hint === null) return;
    const control = hint.control;
    const original = control.getAttribute('aria-describedby')?.split(/\s+/u).filter(Boolean) ?? [];
    if (!original.includes(id)) control.setAttribute('aria-describedby', [...original, id].join(' '));
    return () => {
      const current = control.getAttribute('aria-describedby')?.split(/\s+/u).filter(value => value !== id) ?? [];
      if (current.length > 0) control.setAttribute('aria-describedby', current.join(' '));
      else control.removeAttribute('aria-describedby');
    };
  }, [hint, id]);
  useLayoutEffect(() => {
    if (hint === null) { setPosition(null); return; }
    const place = (): void => {
      const box = hintElement.current?.getBoundingClientRect(), control = hint.control.getBoundingClientRect();
      if (box === undefined) return;
      const margin = 8, width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
      const left = Math.max(margin, Math.min(control.left + control.width / 2 - box.width / 2, width - box.width - margin));
      const below = control.bottom + margin;
      const top = Math.max(margin, Math.min(below + box.height <= height - margin ? below : control.top - box.height - margin, height - box.height - margin));
      setPosition(previous => previous?.left === left && previous.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [hint, scale]);
  if (hint === null) return null;
  return createPortal(<div ref={hintElement} id={id} role="tooltip" className="pcad-keyboard-control-hint"
    style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position === null ? 'hidden' : 'visible' }}>
    {hint.text}
  </div>, hint.host);
}
