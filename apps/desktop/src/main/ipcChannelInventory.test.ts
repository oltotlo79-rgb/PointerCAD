import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { SixDofGate } from './sixDofGate.js';
import { registerSixDofIpc } from './sixDofIpc.js';

/*
 * 画面(preload)から本体へ届く IPC の口の一覧(許す口の表)。口を足す・消す時は、この表を直す(直さずに足すと、
 * この検査が落ちて分かる)。3D マウスの 3 本(B-09 3-5)は、本体の定数(sixDofIpc.ts)とも文字列をそろえる。
 */
const ALLOWED_INVOKE_CHANNELS = [
  'pcad:cancelExportSave', 'pcad:clearTarget', 'pcad:closeAnswer', 'pcad:closeChoice', 'pcad:closeGuardReady', 'pcad:closeGuardState',
  'pcad:confirmTarget', 'pcad:hasTarget', 'pcad:openAbort', 'pcad:openAny', 'pcad:openBegin', 'pcad:openCamTool', 'pcad:openChunk',
  'pcad:openExport', 'pcad:openFinish', 'pcad:openReread', 'pcad:prepareOcctTransport', 'pcad:print', 'pcad:saveAbort', 'pcad:saveAs',
  'pcad:saveBegin', 'pcad:saveChunk', 'pcad:saveCommit', 'pcad:saveExport',
  'pcad:sixDof:disable', 'pcad:sixDof:enable', 'pcad:sixDof:state',
];
const ALLOWED_RECEIVE_CHANNELS = ['pcad:closeRequest'];

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

function channelsOf(source: string, method: 'invoke' | 'on' | 'send' | 'sendSync'): string[] {
  const pattern = new RegExp(`ipcRenderer\\.${method}\\(\\s*'([^']+)'`, 'gu');
  return [...new Set(Array.from(source.matchAll(pattern), (match) => match[1] ?? ''))].sort();
}

describe('画面から本体へ届く IPC の口は、許す口の表のとおり', () => {
  const preload = read('../preload/preload.ts');

  it('呼び出し(invoke)と受け取り(on)の口が表と一致し、送りっぱなし(send)の口は無い', () => {
    expect(channelsOf(preload, 'invoke')).toEqual([...ALLOWED_INVOKE_CHANNELS].sort());
    expect(channelsOf(preload, 'on')).toEqual([...ALLOWED_RECEIVE_CHANNELS].sort());
    expect(channelsOf(preload, 'send')).toEqual([]);
    expect(channelsOf(preload, 'sendSync')).toEqual([]);
  });

  it('3D マウスの 3 本は、本体の定数と同じ文字列で、入の値を渡す引数を持たない', () => {
    // 本体が実際に登録する口の名前を、公開の口(registerSixDofIpc)に偽の ipcMain を渡して集める。
    const registered: string[] = [];
    const gate: SixDofGate = { enabled: () => false, set: () => false };
    registerSixDofIpc({ handle: (channel) => { registered.push(channel); } }, gate, () => Promise.resolve(false), () => false);
    const constants = [...registered].sort();
    expect(constants).toEqual(['pcad:sixDof:disable', 'pcad:sixDof:enable', 'pcad:sixDof:state']);
    for (const channel of constants) expect(preload).toContain(`ipcRenderer.invoke('${channel}')`);
  });
});
