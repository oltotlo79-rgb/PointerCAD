import type { ScreenRect } from '../solid/faceScreenRect.js';
import { findCoachTarget } from './coachTarget.js';

type GuideAnchor = Readonly<{ kind: 'command' | 'region'; id: string }>;

function visibleRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
    && rect.left < window.innerWidth && rect.top < window.innerHeight
    && style.visibility === 'visible' ? rect : null;
}

/** Map the chosen rectangle back to its element so a resize or a replacement can be observed. */
export function locateGuideAnchor(anchor: GuideAnchor) {
  const id = CSS.escape(anchor.id);
  if (anchor.kind === 'region') {
    const element = document.querySelector<HTMLElement>(`[data-guide-id="${id}"]`);
    const rect = element && visibleRect(element);
    return rect && element ? { element, rect, group: null } : null;
  }
  const elements = new Map<ScreenRect, { element: HTMLElement; rect: DOMRect }>();
  const measure = (element: HTMLElement) => {
    const rect = visibleRect(element);
    if (rect) elements.set(rect, { element, rect });
    return rect;
  };
  const commands = Array.from(document.querySelectorAll<HTMLElement>(`[data-command-id="${id}"]`),
    element => ({ commandId: anchor.id, rect: measure(element) }));
  const triggers = document.querySelectorAll<HTMLElement>(
    `[data-menu-trigger][aria-expanded="false"][data-guide-commands~="${id}"]`);
  const collapsedGroups = Array.from(triggers).flatMap(element => {
    const rect = measure(element);
    return rect ? [{ groupId: element.dataset.guideGroup ?? '', commandIds: [anchor.id], rect }] : [];
  });
  const target = findCoachTarget(anchor.id, { commands, collapsedGroups });
  if (target.kind === 'text') return null;
  const match = elements.get(target.rect);
  return match ? { ...match, group: target.kind === 'group' ? target.groupId : null } : null;
}
