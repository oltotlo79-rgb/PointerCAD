import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

/** Render once with the actual current external-store snapshot, restoring the hook even on failure. */
export function renderCurrentStore(component: () => React.JSX.Element | null): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(component)); } finally { snapshot.mockRestore(); }
}
