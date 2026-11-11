import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidFiniteBoundaryFields } from './SolidFiniteBoundaryFields.js';

beforeEach(() => {
  resetTestStore(); vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
  useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidFinite();
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

it('renders finite support and gravity drafts from the actual finite store', () => {
  const initial = useAppStore.getState().solidFiniteSession;
  if (!initial) throw new Error('Missing finite session');
  useAppStore.setState({ solidFiniteSession: { ...initial, fixedFaces: ['face-key'] } });
  useAppStore.getState().editSolidFinite({ kind: 'convert-clamp', face: 'face-key' });
  useAppStore.getState().editSolidFinite({ kind: 'support', face: 'face-key', axis: 'x', displacement: '-0.2 mm' });
  useAppStore.getState().editSolidFinite({ kind: 'gravity-enabled', enabled: true });
  const session = useAppStore.getState().solidFiniteSession;
  if (!session) throw new Error('Missing finite session');
  const html = renderToStaticMarkup(<SolidFiniteBoundaryFields session={session} />);
  expect(html).toContain('data-testid="solid-support-0"');
  expect(html).toContain('data-testid="solid-gravity-enabled"');
  expect(session.supports?.[0].displacement[0]).toBe('-0.2 mm');
  expect(session.gravity?.density).toBe('');
});
