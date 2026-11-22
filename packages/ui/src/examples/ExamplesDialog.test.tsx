import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findHelpTopic } from '@pointercad/help-content';
import { ASSEMBLY_EXAMPLES, DRAWING_EXAMPLES, PART_EXAMPLES } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { PartFileDialogs } from '../shell/menus/PartFileDialogs.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { renderCurrentStore } from '../store/testing/renderCurrentStore.testSupport.js';
import { useAppStore } from '../store/useAppStore.js';
import { ASSEMBLY_EXAMPLE_ENTRIES, DRAWING_EXAMPLE_ENTRIES } from './documentExampleEntries.js';
import { ExamplesDialog } from './ExamplesDialog.js';
import { PART_EXAMPLE_ENTRIES } from './partExampleEntries.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

const groups = [
  { heading: 'examples.group.part', examples: PART_EXAMPLES, entries: PART_EXAMPLE_ENTRIES },
  { heading: 'examples.group.assembly', examples: ASSEMBLY_EXAMPLES, entries: ASSEMBLY_EXAMPLE_ENTRIES },
  { heading: 'examples.group.drawing', examples: DRAWING_EXAMPLES, entries: DRAWING_EXAMPLE_ENTRIES },
] as const;
const entries = { ...PART_EXAMPLE_ENTRIES, ...ASSEMBLY_EXAMPLE_ENTRIES, ...DRAWING_EXAMPLE_ENTRIES };
const ids = [...PART_EXAMPLES, ...ASSEMBLY_EXAMPLES, ...DRAWING_EXAMPLES].map(example => example.id);

describe('作例の一覧の窓(J-06b)', () => {
  it('画面の表は model の作例とちょうど同じ id を持つ(抜けも余りも無い)', () => {
    for (const group of groups) {
      expect(Object.keys(group.entries).sort()).toEqual(group.examples.map(example => example.id).sort());
    }
  });

  it('作例を model と同じ順に並べ、どの行も名前・一言・使う機能と、開く・説明の釦を持つ', () => {
    const markup = renderToStaticMarkup(createElement(ExamplesDialog, { onClose: () => undefined }));
    const sections = [...markup.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/gu)];
    expect(sections).toHaveLength(groups.length);
    for (const [index, { heading, examples }] of groups.entries()) {
      const section = sections[index][1];
      expect(section).toContain(`>${t(heading)}</h3>`);
      expect([...section.matchAll(/data-example-id="([^"]+)"/gu)].map(match => match[1])).toEqual(examples.map(example => example.id));
    }
    expect(markup.match(/<li /gu)).toHaveLength(ids.length);
    expect(markup).toContain(t('examples.title'));
    expect(markup).toContain(t('examples.intro'));
    for (const id of ids) {
      const entry = entries[id];
      for (const key of [entry.nameKey, entry.summaryKey, entry.featuresKey]) expect(markup, `${id}: ${key}`).toContain(t(key));
      expect(markup).toContain(`aria-label="${t('examples.open')} ${t(entry.nameKey)}"`);
      expect(markup).toContain(`aria-label="${t('examples.help')} ${t(entry.nameKey)}"`);
    }
    const buttons = markup.match(/<button\b[^>]*>/gu) ?? [];
    expect(buttons).toHaveLength(2 * ids.length + 1);
    for (const button of buttons) expect(button).toMatch(/ title="[^"]+"/u);
  });

  it('名前・一言・使う機能は作例ごとに違い、空の文言が無い', () => {
    for (const field of ['nameKey', 'summaryKey', 'featuresKey'] as const) {
      const texts = ids.map(id => t(entries[id][field]));
      expect(texts.every(text => text.trim().length > 0), field).toBe(true);
      if (field !== 'featuresKey') expect(new Set(texts).size, field).toBe(ids.length);
    }
  });

  it('説明の釦が開く頁はどれも実在する', () => {
    for (const id of ids) expect(findHelpTopic(entries[id].helpTopic), id).toBeDefined();
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
