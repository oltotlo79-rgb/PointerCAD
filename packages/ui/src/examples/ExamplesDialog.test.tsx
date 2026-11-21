import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findHelpTopic } from '@pointercad/help-content';
import { PART_EXAMPLES } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { PartFileDialogs } from '../shell/menus/PartFileDialogs.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { ExamplesDialog } from './ExamplesDialog.js';
import { PART_EXAMPLE_ENTRIES } from './partExampleEntries.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

const ids = PART_EXAMPLES.map(example => example.id);

describe('作例の一覧の窓(J-06b)', () => {
  it('画面の表は model の作例とちょうど同じ id を持つ(抜けも余りも無い)', () => {
    expect(Object.keys(PART_EXAMPLE_ENTRIES).sort()).toEqual([...ids].sort());
  });

  it('作例を model と同じ順に並べ、どの行も名前・一言・使う機能と、開く・説明の釦を持つ', () => {
    const markup = renderToStaticMarkup(createElement(ExamplesDialog, { onClose: () => undefined }));
    const positions = ids.map(id => markup.indexOf(`data-example-id="${id}"`));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(markup.match(/<li /gu)).toHaveLength(ids.length);
    expect(markup).toContain(t('examples.title'));
    expect(markup).toContain(t('examples.intro'));
    for (const id of ids) {
      const entry = PART_EXAMPLE_ENTRIES[id];
      for (const key of [entry.nameKey, entry.summaryKey, entry.featuresKey]) expect(markup, `${id}: ${key}`).toContain(t(key));
      expect(markup).toContain(`aria-label="${t('examples.open')} ${t(entry.nameKey)}"`);
      expect(markup).toContain(`aria-label="${t('examples.help')} ${t(entry.nameKey)}"`);
    }
  });

  it('名前・一言・使う機能は作例ごとに違い、空の文言が無い', () => {
    for (const field of ['nameKey', 'summaryKey', 'featuresKey'] as const) {
      const texts = ids.map(id => t(PART_EXAMPLE_ENTRIES[id][field]));
      expect(texts.every(text => text.trim().length > 0), field).toBe(true);
      if (field !== 'featuresKey') expect(new Set(texts).size, field).toBe(ids.length);
    }
  });

  it('説明の釦が開く頁はどれも実在する', () => {
    for (const id of ids) expect(findHelpTopic(PART_EXAMPLE_ENTRIES[id].helpTopic), id).toBeDefined();
    expect(findHelpTopic('tutorial')).toBeDefined();
  });

  it('部品の窓の置き場は、補助画面の欄が「作例」の時だけ一覧を出す', () => {
    expect(renderCurrentStore(PartFileDialogs)).toBe('');
    useAppStore.getState().setUtilityPanelOpen('examples', true);
    expect(renderCurrentStore(PartFileDialogs)).toContain(t('examples.title'));
    useAppStore.getState().setUtilityPanelOpen('examples', false);
    expect(renderCurrentStore(PartFileDialogs)).toBe('');
  });
});
