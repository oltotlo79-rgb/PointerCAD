import { describe, expect, it } from 'vitest';
import { createScriptFile } from '@pointercad/model/scripting';
import { readScriptLibrary, writeScriptLibrary, type ScriptLibraryStorage } from './scriptLibrary.js';
import { fileFromDraft } from './scriptDraft.js';

async function fixture() {
  const result = await createScriptFile({ scriptId: 'tool', name: '自動作図', icon: 'gear', source: "console.log('hello');", modules: [], seed: 42, timeMs: 1800000000000 });
  if (!result.ok) throw new Error(result.reason); return result.file;
}
describe('登録道具の永続化', () => {
  it('保存→別口から読込、更新、削除、復元を同じデータで行う', async () => {
    let saved: string | null = null;
    const storage: ScriptLibraryStorage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
    const file = await fixture();
    expect(await writeScriptLibrary(storage, [file])).toBe(true);
    expect(await readScriptLibrary(storage)).toEqual({ ok: true, tools: [file] });
    expect(await writeScriptLibrary(storage, [])).toBe(true); expect(await readScriptLibrary(storage)).toEqual({ ok: true, tools: [] });
    expect(await writeScriptLibrary(storage, [{ ...file, name: '改名' }])).toBe(true);
    expect(await readScriptLibrary(storage)).toEqual({ ok: true, tools: [{ ...file, name: '改名' }] });
  });
  it('容量不足と不正な置換では以前の保存内容を失わない', async () => {
    const file = await fixture(), original = JSON.stringify([file]); let writes = 0;
    const storage: ScriptLibraryStorage = { getItem: () => original, setItem: () => { writes++; throw new Error('quota'); } };
    expect(await writeScriptLibrary(storage, [file, file])).toBe(false); expect(writes).toBe(0);
    expect(await writeScriptLibrary(storage, [])).toBe(false); expect(writes).toBe(1);
    expect(await readScriptLibrary(storage)).toEqual({ ok: true, tools: [file] });
  });
  it('壊れた保存内容を空一覧にして上書きしない', async () => {
    let writes = 0;
    expect(await readScriptLibrary({ getItem: () => '{broken', setItem: () => { writes++; } })).toEqual({ ok: false });
    expect(writes).toBe(0); expect(await readScriptLibrary(null)).toEqual({ ok: false });
  });
  it('別IDでも重複名は拒み、100件の上限を実データで守る', async () => {
    const file = await fixture(); let saved: string | null = null;
    const storage: ScriptLibraryStorage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
    expect(await writeScriptLibrary(storage, [file, { ...file, scriptId: 'different' }])).toBe(false);
    const tools = Array.from({ length: 100 }, (_, index) => ({ ...file, scriptId: `tool-${index}`, name: `道具${index}` }));
    expect(await writeScriptLibrary(storage, tools)).toBe(true);
    expect(await writeScriptLibrary(storage, [...tools, { ...file, scriptId: 'extra', name: '追加' }])).toBe(false);
    const loaded = await readScriptLibrary(storage); expect(loaded.ok && loaded.tools.length).toBe(100);
  });
  it('明示UTCと整数seedを要求する', async () => {
    const draft = { scriptId: 'test', name: '入力', icon: 'code', source: '', modules: [], seed: '1', time: '2026-09-11T12:00:00Z' } satisfies Parameters<typeof fileFromDraft>[0];
    expect((await fileFromDraft(draft)).ok).toBe(true);
    for (const time of ['2026-09-11', '2026-09-11T12:00:00', '2026-02-30T12:00:00Z', 'not-a-date']) expect((await fileFromDraft({ ...draft, time })).ok).toBe(false);
    for (const seed of ['NaN', '0.1', '-1', '4294967296']) expect((await fileFromDraft({ ...draft, seed })).ok).toBe(false);
  });
});
