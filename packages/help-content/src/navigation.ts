/** Shared by the in-app reader and generated manual; histories contain no document data. */
export interface HelpVisit { readonly topicId: string; readonly anchor: string; readonly scrollTop: number }
export interface HelpHistory { readonly visits: readonly HelpVisit[]; readonly index: number }
const MAX_VISITS = 100;

export function initialHelpHistory(topicId: string): HelpHistory {
  return { visits: [{ topicId, anchor: '', scrollTop: 0 }], index: 0 };
}

export function visitHelp(history: HelpHistory, target: HelpVisit, scrollTop: number): HelpHistory {
  const current = history.visits[history.index];
  if (current.topicId === target.topicId && current.anchor === target.anchor) return history;
  const kept = history.visits.slice(0, history.index + 1);
  kept[kept.length - 1] = { ...current, scrollTop: Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0) };
  const visits = [...kept, target].slice(-MAX_VISITS);
  return { visits, index: visits.length - 1 };
}

export function stepHelpHistory(history: HelpHistory, direction: -1 | 1, scrollTop: number): HelpHistory {
  const index = history.index + direction;
  if (index < 0 || index >= history.visits.length) return history;
  const visits = history.visits.map((visit, position) => position === history.index
    ? { ...visit, scrollTop: Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0) } : visit);
  return { visits, index };
}

export function adjacentHelpTopics<T extends { readonly id: string }>(topics: readonly T[], id: string) {
  const index = topics.findIndex(topic => topic.id === id);
  return { previous: index > 0 ? topics[index - 1] : undefined,
    next: index >= 0 && index + 1 < topics.length ? topics[index + 1] : undefined };
}
