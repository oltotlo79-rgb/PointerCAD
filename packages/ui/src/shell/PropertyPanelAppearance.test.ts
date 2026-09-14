import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appearanceFromPreset, appendSolid, assignBodyAppearance } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PropertyPanel } from './PropertyPanel.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { bodyFor, extrudeFeature, partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

function render(): string {
  // Read the selected document in this server-rendered test, as the browser hook does.
  const snapshot = vi.spyOn(React, 'useSyncExternalStore')
    .mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(PropertyPanel)); }
  finally { snapshot.mockRestore(); }
}

describe('外観の部品を分離した後も質量特性の材料選択を表示する', () => {
  it.each([
    ['aluminum', '2.68'],
    ['steel', '7.85'],
  ] as const)('%sの外観と材料・密度を同じプロパティへ表示し、文書を変更しない', (preset, density) => {
    const feature = extrudeFeature('measured-solid');
    const document = assignBodyAppearance(appendSolid(partWithPoint(), feature), feature.id, appearanceFromPreset(preset));
    useAppStore.getState().applyDocument(document);
    useAppStore.setState({ bodies: [bodyFor(feature.id)], selection: [feature.id], selectionKind: 'body', isComputing: false });
    const before = useAppStore.getState();

    const markup = render();
    expect(markup).toContain(t('propertyPanel.sectionAppearance'));
    expect(markup).toContain(t('propertyPanel.sectionMassProperties'));
    expect(markup).toContain(t('propertyPanel.massMaterial'));
    expect(markup).toContain(`value="${density}"`);
    expect(useAppStore.getState()).toBe(before);

    useAppStore.setState({ selection: [] });
    expect(render()).not.toContain(t('propertyPanel.sectionMassProperties'));
    expect(useAppStore.getState().document).toBe(document);
  });
});
