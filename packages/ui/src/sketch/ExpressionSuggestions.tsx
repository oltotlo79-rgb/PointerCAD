import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { firstFittingPopover } from '../shell/popoverPlacement.js';
import type { expressionCandidates } from './expressionCompletion.js';

/** The list touches its field, is at least as wide as the field and scrolls beyond this height (CSS pixels). */
const LIST_MAX_HEIGHT = 220;
const LIST_MIN_WIDTH = 180;
const ATTACHED = { inset: { left: 0, top: 0 }, gap: 0 };

interface SuggestionListProps {
  readonly input: HTMLInputElement;
  readonly id: string;
  readonly label: string;
  readonly candidates: ReturnType<typeof expressionCandidates>;
  readonly selected: number;
  readonly accept: (index: number) => void;
}

/** Below the field when the whole list fits, else above; when neither fits, the roomier side scrolls. */
function listPosition(input: HTMLInputElement, contentHeight: number): React.CSSProperties {
  const rect = input.getBoundingClientRect();
  const root = input.ownerDocument.documentElement;
  const viewport = { width: root.clientWidth, height: root.clientHeight };
  const width = Math.min(viewport.width, Math.max(LIST_MIN_WIDTH, rect.width));
  const left = Math.max(0, Math.min(rect.left, viewport.width - width));
  const height = Math.min(LIST_MAX_HEIGHT, contentHeight);
  const fit = firstFittingPopover(['below', 'above'], rect, { left, top: rect.bottom }, { width, height }, viewport, ATTACHED);
  if (fit !== null) return { left, width, top: fit.top, maxHeight: height };
  const below = viewport.height - rect.bottom;
  return below >= rect.top ? { left, width, top: rect.bottom, maxHeight: Math.max(0, below) }
    : { left, width, bottom: viewport.height - rect.top, maxHeight: rect.top };
}

/** The border-box height the list needs to show every option without scrolling. */
function contentHeightOf(list: HTMLDivElement | null): number {
  return list === null ? LIST_MAX_HEIGHT : list.scrollHeight + list.offsetHeight - list.clientHeight;
}

export function ExpressionSuggestions({ input, id, label, candidates, selected, accept }: SuggestionListProps): React.JSX.Element {
  const [style, setStyle] = useState(() => listPosition(input, LIST_MAX_HEIGHT));
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const refresh = (): void => { setStyle(listPosition(input, contentHeightOf(list.current))); };
    const view = input.ownerDocument.defaultView;
    const observer = new ResizeObserver(refresh);
    observer.observe(input);
    view?.addEventListener('resize', refresh);
    view?.addEventListener('scroll', refresh, true);
    refresh();
    return () => {
      observer.disconnect();
      view?.removeEventListener('scroll', refresh, true);
      view?.removeEventListener('resize', refresh);
    };
  }, [input, candidates.length]);
  useLayoutEffect(() => {
    list.current?.children.item(selected)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const host = input.closest('dialog[open], [role="dialog"]') ?? input.closest('.pcad-shell') ?? input.ownerDocument.body;
  return createPortal(<div id={id} ref={list} role="listbox" aria-label={label} style={style} className="pcad-field__suggestions">
    {candidates.map((candidate, index) => <div key={candidate.name} id={id + '-' + String(index)}
      role="option" aria-selected={selected === index} onMouseDown={event => event.preventDefault()}
      onClick={() => accept(index)}>{candidate.name}{candidate.detail === '' ? '' : ' · ' + candidate.detail}</div>)}
  </div>, host);
}
