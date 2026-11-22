import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameSlotFasteningPopover } from '../assembly/FrameSlotFasteningPopover.js';
import { createFrameSlotDraft } from '../assembly/frameSlotFasteningDraft.js';
import { t } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import type * as ImportedUseAppStoreTypes from '../store/useAppStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SelectionModifier } from './selectionModifierSetting.js';

// 描いた部品が店から何を選び出したか(selector)を控える。描き直しは、選び出した値が変わった時だけ起きる(zustand)。
const recorded = vi.hoisted(() => ({ selectors: [] as ((state: AppState) => unknown)[] }));

vi.mock('../store/useAppStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImportedUseAppStoreTypes>();
  const original = actual.useAppStore;
  const hook = Object.assign(
    // 静的な描画では店の hook が初めの値を読むので、今の値で選び出す(先例 file/ExchangePanel.test.ts の包みと同じ)。
    <T,>(selector: (state: AppState) => T): T => {
      recorded.selectors.push(selector);
      return selector(original.getState());
    },
    { getState: original.getState, getInitialState: original.getInitialState, setState: original.setState, subscribe: original.subscribe },
  );
  return { ...actual, useAppStore: hook };
});

function choose(selectionModifier: SelectionModifier): void {
  useAppStore.setState({ displaySettings: { ...useAppStore.getState().displaySettings, selectionModifier } });
}

/** 控えた選び出しのうち、同じ店で同じ値を返す物(毎回新しい物を作らない物)が、change の後に違う値を返すか。 */
function rerendersOn(change: () => void): boolean {
  const before = useAppStore.getState();
  const stable = recorded.selectors.filter(selector => Object.is(selector(before), selector(before)));
  change();
  const after = useAppStore.getState();
  return stable.some(selector => !Object.is(selector(before), selector(after)));
}

afterEach(() => {
  choose('local');
  useAppStore.setState({ assemblyFrameSlotDraft: null, assemblyFrameSlotPreview: null });
  recorded.selectors.length = 0;
});

describe('選択のキーの案内の文を出す部品は、設定を変えると描き直す(B-08 2-5)', () => {
  it('溝の締結の窓: 設定を変えると描き直しの対象になり、案内の文が選んだキーに替わる', () => {
    useAppStore.setState({ assemblyFrameSlotDraft: createFrameSlotDraft('doc'), assemblyFrameSlotPreview: null });
    const before = renderToStaticMarkup(<FrameSlotFasteningPopover />);
    expect(before).toContain(t('assembly.frameSlot.pickHole'));
    expect(before).toContain('（Shift で足し外し）');
    expect(rerendersOn(() => { choose('ctrl'); })).toBe(true);
    const after = renderToStaticMarkup(<FrameSlotFasteningPopover />);
    expect(after).toContain('ブラケットの穴の内側の面を選んでください（Ctrl で足し外し）。');
    expect(after).not.toContain('（Shift で足し外し）');
  });

  it('窓が選び出さない欄(計算中の印)を変えても描き直しの対象にならない(上の見張りが何にでも反応しない事の対照)', () => {
    useAppStore.setState({ assemblyFrameSlotDraft: createFrameSlotDraft('doc'), assemblyFrameSlotPreview: null });
    renderToStaticMarkup(<FrameSlotFasteningPopover />);
    const computing = useAppStore.getState().isComputing;
    try {
      expect(rerendersOn(() => { useAppStore.setState({ isComputing: !computing }); })).toBe(false);
    } finally { useAppStore.setState({ isComputing: computing }); }
  });
});
