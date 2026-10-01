import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { t } from '../i18n/t.js';
import { attachDraggableWindow } from './draggableWindowLayout.js';
import './draggableWindow.css';

/** Keep each window's heading semantics and its existing focus/keyboard ownership. */
export function DraggableWindowTitle({ as: Tag = 'div', children, className = '', id, enabled = true }: {
  readonly as?: 'div' | 'h2' | 'h3' | 'span' | 'strong';
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
  readonly enabled?: boolean;
}): React.JSX.Element {
  const title = useRef<HTMLElement | null>(null);
  const attachment = useRef<ReturnType<typeof attachDraggableWindow> | null>(null);
  useLayoutEffect(() => {
    if (!enabled || title.current === null) return;
    const element = title.current.closest<HTMLElement>('dialog, .pcad-popover, .pcad-drawing-input');
    if (element === null) return;
    const connected = attachDraggableWindow(element, title.current);
    attachment.current = connected;
    return () => { connected.dispose(); attachment.current = null; };
  }, [enabled]);
  // Reconcile changed anchors and stages without replacing the window or its focused field.
  useLayoutEffect(() => { attachment.current?.refresh(); });
  return <Tag ref={element => { title.current = element; }} id={id} className={`${className}${enabled ? ' pcad-window-title' : ''}`.trim()}
    title={enabled ? t('numericInput.moveWindow') : undefined}>
    {enabled ? <span className="pcad-window-title__grip" aria-hidden="true" /> : null}{children}
  </Tag>;
}
