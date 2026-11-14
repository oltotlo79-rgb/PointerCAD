import { describe, expect, it, vi } from 'vitest';
import { createDesktopFileGateway } from './desktopFileGateway.js';

vi.mock('@pointercad/ui', () => ({ t: (key: string) => key }));

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('未初期化'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** 案Bの「保存」の 4 つの口。確定の答えだけを検査ごとに変える。 */
function savePorts(commit: () => Promise<unknown>) {
  return {
    beginPcadSave: vi.fn<(name: string, saveAs: boolean, kind: string, totalBytes: number) => Promise<unknown>>(
      () => Promise.resolve({ transferId: 'transfer-1', chunkBytes: 4 })),
    sendPcadSaveChunk: vi.fn((): Promise<unknown> => Promise.resolve(true)),
    commitPcadSave: vi.fn(commit),
    abortPcadSave: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
  };
}

/** 区切って読む「開く」の 4 つの口。既定は窓の取消(開始が null)。 */
function openPorts(begin: () => Promise<unknown> = () => Promise.resolve(null)) {
  return {
    beginPcadOpen: vi.fn<(kind?: string) => Promise<unknown>>(begin),
    readPcadOpenChunk: vi.fn<(readId: string, index: number) => Promise<unknown>>(() => Promise.resolve(new Uint8Array(0))),
    finishPcadOpen: vi.fn<(readId: string) => Promise<unknown>>(() => Promise.resolve('save-target-1')),
    abortPcadOpen: vi.fn<(readId: string) => Promise<unknown>>(() => Promise.resolve(undefined)),
    rereadPcadOpen: vi.fn<(token: string) => Promise<unknown>>(() => Promise.resolve(null)),
  };
}

describe('デスクトップ画面の保存先キャッシュ（レビュー R02）', () => {
  it('通常saveAsにもcontrolを渡しpicker中取消の旧成功を採らない', async () => {
    const pending = deferred<boolean>();
    const api = {
      ...openPorts(), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), ...savePorts(() => Promise.resolve(null)),
      hasSaveTarget: () => Promise.resolve(false),
      openFile: () => Promise.resolve(null), saveFileAs: vi.fn<(
        name: string, kind: string, bytes: Uint8Array, requestId?: string,
      ) => Promise<boolean>>(() => pending.promise),
      cancelExportSave: vi.fn(() => Promise.resolve(true)),
    };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.saveFileAs === undefined) throw new Error('saveAs口なし');
    const controller = new AbortController();
    const saving = gateway.saveFileAs('part.3mf', '3mf', Uint8Array.of(1),
      { signal: controller.signal, isCurrent: () => !controller.signal.aborted });
    const requestId: unknown = api.saveFileAs.mock.calls[0]?.[3];
    expect(requestId).toMatch(/^[\da-f-]{36}$/i);
    controller.abort();
    expect(api.cancelExportSave).toHaveBeenCalledExactlyOnceWith(requestId);
    pending.resolve(true);
    expect(await saving).toBe(false);
    expect(gateway.hasSaveTarget()).toBe(false);
  });
  it('旧preloadに取消口がないときcontrol付き通常saveAsは開始しない', async () => {
    const api = { ...openPorts(), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), ...savePorts(() => Promise.resolve(null)),
      hasSaveTarget: () => Promise.resolve(false), openFile: () => Promise.resolve(null),
      saveFileAs: vi.fn(() => Promise.resolve(true)) };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    const controller = new AbortController();
    expect(await gateway?.saveFileAs?.('part.stl', 'stl', Uint8Array.of(1),
      { signal: controller.signal, isCurrent: () => true })).toBe(false);
    expect(api.saveFileAs).not.toHaveBeenCalled();
  });
  it('解除後に古い保存が返っても上書き先ありに戻さない', async () => {
    const saved = deferred<string>();
    const gateway = createDesktopFileGateway({ pointercadDesktop: {
      ...openPorts(), confirmSaveTarget: () => Promise.resolve(true), clearSaveTarget: () => Promise.resolve(undefined),
      ...savePorts(() => saved.promise), hasSaveTarget: () => Promise.resolve(false),
    } });
    if (gateway === null) throw new Error('gateway が必要');
    const pending = gateway.savePcad('A.pcad', Uint8Array.of(1), true);
    gateway.clearSaveTarget?.(); saved.resolve('A.pcad');
    expect(await pending).toBeNull(); expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('古い確定依頼の返答が新しい確定を取り消さない', async () => {
    const old = deferred<boolean>();
    const gateway = createDesktopFileGateway({ pointercadDesktop: {
      ...openPorts(), confirmSaveTarget: (token: string) => token === 'old' ? old.promise : Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), ...savePorts(() => Promise.resolve('A.pcad')), hasSaveTarget: () => Promise.resolve(false),
    } });
    if (gateway === null) throw new Error('gateway が必要');
    const pending = gateway.confirmSaveTarget?.('old');
    gateway.clearSaveTarget?.(); await gateway.confirmSaveTarget?.('new');
    old.resolve(false); await pending;
    expect(gateway.hasSaveTarget()).toBe(true);
  });
});

describe('図面の読み書きを本体プロセスへ届ける（P8-64）', () => {
  it.each(['pcadscript', 'step', 'stl', 'pcadt'] satisfies Array<'pcadscript' | 'step' | 'stl' | 'pcadt'>)('%sの読込に通常文書の保存先tokenを要求しない', async kind => {
    const bytes = Uint8Array.of(1, 2, 3);
    const api = {
      ...openPorts(), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), ...savePorts(() => Promise.resolve('model.pcad')), hasSaveTarget: () => Promise.resolve(true),
      openFile: vi.fn(() => Promise.resolve({ name: `sample.${kind}`, kind, bytes })), saveFileAs: () => Promise.resolve(true),
    };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.openFile === undefined) throw new Error('typed gateway required');
    await Promise.resolve();
    expect(await gateway.openFile([kind])).toEqual({ fileName: `sample.${kind}`, kind, bytes });
    expect(api.openFile).toHaveBeenCalledWith([kind]);
    expect(gateway.hasSaveTarget()).toBe(true);
  });
  it('図面のバイト列・形式と保存先の確定を往復し、パスを画面へ出さない', async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const api = {
      ...openPorts(() => Promise.resolve({ readId: 'read-drawing', name: '組図.pcadd', size: 3, chunkBytes: 8 })),
      confirmSaveTarget: vi.fn(() => Promise.resolve(true)), clearSaveTarget: () => Promise.resolve(undefined),
      ...savePorts(() => Promise.resolve('組図.pcadd')), hasSaveTarget: () => Promise.resolve(false),
    };
    api.readPcadOpenChunk.mockResolvedValueOnce(bytes.slice());
    api.finishPcadOpen.mockResolvedValueOnce('opaque-drawing');
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    const opened = await gateway.openPcad('drawing');
    expect(api.beginPcadOpen).toHaveBeenCalledWith('drawing');
    expect(api.readPcadOpenChunk).toHaveBeenCalledExactlyOnceWith('read-drawing', 0);
    expect(api.finishPcadOpen).toHaveBeenCalledExactlyOnceWith('read-drawing');
    expect(opened).toMatchObject({ name: '組図.pcadd', bytes, saveTargetToken: 'opaque-drawing', owned: true });
    expect(Object.keys(opened ?? {}).sort()).toEqual(['bytes', 'name', 'owned', 'reread', 'saveTargetToken']);
    expect(typeof opened?.reread).toBe('function');
    expect(gateway.hasSaveTarget()).toBe(false);
    await gateway.confirmSaveTarget?.('opaque-drawing'); expect(gateway.hasSaveTarget()).toBe(true);
    expect(await gateway.savePcad('組図.pcadd', bytes, false, 'drawing')).toBe('組図.pcadd');
    expect(api.beginPcadSave).toHaveBeenCalledWith('組図.pcadd', false, 'drawing', 3);
  });
});

describe('「開く」の大きさ関連の失敗をWeb版と同じ鍵で画面へ出す（P12-26 続き）', () => {
  // 本体プロセス(pcadDialogs.ts)の印。文字列は同じ値を書き写している(実装ファイルの注記参照)。
  const TOO_LARGE_MARKER = 'PCAD_READ_TOO_LARGE:';
  const SIZE_CHANGED_MARKER = 'PCAD_READ_SIZE_CHANGED:';
  // Electron の ipcRenderer.invoke が実際に拒否する文面の形を模す(saveFailure.test.ts と同じ流儀)。
  const asIpcRejection = (channel: string, marker: string, text: string) =>
    new Error(`Error invoking remote method '${channel}': Error: ${marker} ${text}`);

  function apiWith(overrides: { begin?: () => Promise<unknown>; chunk?: () => Promise<unknown>; openFile?: () => Promise<unknown> }) {
    const ports = openPorts(overrides.begin);
    if (overrides.chunk !== undefined) ports.readPcadOpenChunk.mockImplementation(overrides.chunk);
    return {
      ...ports,
      confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined),
      ...savePorts(() => Promise.resolve(null)),
      hasSaveTarget: () => Promise.resolve(false),
      openFile: overrides.openFile ?? (() => Promise.resolve(null)),
      saveFileAs: () => Promise.resolve(false),
    };
  }

  it('部品を開く(openPcad)で大きすぎるとき、Web版と同じfile.error.tooLargeを投げる', async () => {
    const api = apiWith({ begin: () => Promise.reject(
      asIpcRejection('pcad:openBegin', TOO_LARGE_MARKER, 'ファイルが大きすぎます。種類ごとの読込上限を超えています。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    await expect(gateway.openPcad('part')).rejects.toThrow('file.error.tooLarge');
  });

  it('部品を開く(openPcad)で読込中に大きさが変わったとき、Web版と同じfile.error.corruptedを投げる', async () => {
    const api = apiWith({ begin: () => Promise.resolve({ readId: 'read-1', name: 'a.pcad', size: 3, chunkBytes: 8 }),
      chunk: () => Promise.reject(
        asIpcRejection('pcad:openChunk', SIZE_CHANGED_MARKER, '読込中にファイルの大きさが変わりました。もう一度開いてください。'),
      ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    await expect(gateway.openPcad('part')).rejects.toThrow('file.error.corrupted');
    expect(api.abortPcadOpen).toHaveBeenCalledExactlyOnceWith('read-1');
  });

  it('種類つき読込(openFile)で大きすぎるとき、Web版と同じfile.error.tooLargeを投げる', async () => {
    const api = apiWith({ openFile: () => Promise.reject(
      asIpcRejection('pcad:openAny', TOO_LARGE_MARKER, 'ファイルが大きすぎます。種類ごとの読込上限を超えています。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.openFile === undefined) throw new Error('typed gateway required');
    await expect(gateway.openFile(['step'])).rejects.toThrow('file.error.tooLarge');
  });

  it('種類つき読込(openFile)で読込中に大きさが変わったとき、Web版と同じfile.error.corruptedを投げる', async () => {
    const api = apiWith({ openFile: () => Promise.reject(
      asIpcRejection('pcad:openAny', SIZE_CHANGED_MARKER, '読込中にファイルの大きさが変わりました。もう一度開いてください。'),
    ) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway?.openFile === undefined) throw new Error('typed gateway required');
    await expect(gateway.openFile(['step'])).rejects.toThrow('file.error.corrupted');
  });

  it('心当たりのない失敗(印なし)は文面を変えずにそのまま伝える', async () => {
    const api = apiWith({ begin: () => Promise.reject(new Error('permission denied')) });
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('gateway が必要');
    await expect(gateway.openPcad('part')).rejects.toThrow('permission denied');
  });
});

describe('パラメータCSVの画面側口', () => {
  const base = (openFile: () => Promise<unknown>) => ({
    ...openPorts(), confirmSaveTarget: () => Promise.resolve(true),
    clearSaveTarget: () => Promise.resolve(undefined), ...savePorts(() => Promise.resolve(null)),
    hasSaveTarget: () => Promise.resolve(true), openFile, saveFileAs: () => Promise.resolve(false),
  });

  it('CSV専用の依頼を送り、取消と異種応答を分け、保存先を変えない', async () => {
    const openFile = vi.fn(() => Promise.resolve<unknown>({ name: '係数.csv', kind: 'csv', bytes: Uint8Array.of(1) }));
    const gateway = createDesktopFileGateway({ pointercadDesktop: base(openFile) });
    if (gateway?.openParameterCsv === undefined) throw new Error('CSV口が必要');
    expect(await gateway.openParameterCsv()).toEqual({ fileName: '係数.csv', bytes: Uint8Array.of(1) });
    expect(openFile).toHaveBeenCalledWith(['csv']);
    expect(gateway.hasSaveTarget()).toBe(true);
    const cancelled = createDesktopFileGateway({ pointercadDesktop: base(() => Promise.resolve(null)) });
    expect(await cancelled?.openParameterCsv?.()).toBeNull();
    const wrong = createDesktopFileGateway({ pointercadDesktop: base(() => Promise.resolve({
      name: '係数.csv', kind: 'step', bytes: Uint8Array.of(1),
    })) });
    await expect(wrong?.openParameterCsv?.()).rejects.toThrow('file.openFailed');
  });

  it('IPC後の1MiB超過を拒否する', async () => {
    const gateway = createDesktopFileGateway({ pointercadDesktop: base(() => Promise.resolve({
      name: '係数.csv', kind: 'csv', bytes: new Uint8Array(1024 * 1024 + 1),
    })) });
    await expect(gateway?.openParameterCsv?.()).rejects.toThrow('file.error.tooLarge');
  });
});

describe('「保存」のバイト列は本体が決めた大きさに分けて送る（案B）', () => {
  interface SentChunk { readonly transferId: string; readonly index: number; readonly bytes: Uint8Array; readonly digest: string }
  function transferApi(options: { chunkBytes?: number; refuseAt?: number; failAt?: number;
    begin?: () => Promise<unknown>; commit?: () => Promise<unknown> } = {}) {
    const sent: SentChunk[] = [];
    const api = {
      ...openPorts(), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), hasSaveTarget: () => Promise.resolve(false),
      beginPcadSave: vi.fn<(name: string, saveAs: boolean, kind: string, totalBytes: number) => Promise<unknown>>(
        options.begin ?? (() => Promise.resolve({ transferId: 'transfer-1', chunkBytes: options.chunkBytes ?? 4 }))),
      sendPcadSaveChunk: vi.fn((transferId: string, index: number, bytes: Uint8Array, digest: string): Promise<unknown> => {
        sent.push({ transferId, index, bytes, digest });
        if (index === options.failAt) return Promise.reject(new Error('disk full'));
        return Promise.resolve(index !== options.refuseAt);
      }),
      commitPcadSave: vi.fn<(transferId: string) => Promise<unknown>>(options.commit ?? (() => Promise.resolve('A.pcad'))),
      abortPcadSave: vi.fn<(transferId: string) => Promise<unknown>>(() => Promise.resolve(undefined)),
    };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('分けて送る口を持つ preload の gateway が必要');
    return { api, sent, gateway };
  }
  const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
  const whole = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);

  it('開始の答えの大きさで順に分け、各回はその回の長さだけの並びで送り、最後に確定する', async () => {
    const { api, sent, gateway } = transferApi({ chunkBytes: 4 });
    expect(await gateway.savePcad('A.pcad', whole, true, 'drawing')).toBe('A.pcad');
    expect(api.beginPcadSave).toHaveBeenCalledExactlyOnceWith('A.pcad', true, 'drawing', 10);
    expect(sent.map(row => [row.transferId, row.index, [...row.bytes]])).toEqual([
      ['transfer-1', 0, [1, 2, 3, 4]], ['transfer-1', 1, [5, 6, 7, 8]], ['transfer-1', 2, [9, 10]],
    ]);
    for (const row of sent) {
      // 全体の並びの見せ方(subarray)を渡すと、構造化複製が全体を写す。その回の長さだけの並びを送る。
      expect(row.bytes.buffer.byteLength).toBe(row.bytes.byteLength);
      expect(row.bytes.buffer).not.toBe(whole.buffer);
      expect(row.digest).toBe(await hex(row.bytes));
    }
    expect(api.commitPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
    expect(api.abortPcadSave).not.toHaveBeenCalled();
    expect(gateway.hasSaveTarget()).toBe(true);
  });

  it('種類を省いた保存は部品として始め、0バイトなら送らずに確定する', async () => {
    const { api, sent, gateway } = transferApi();
    expect(await gateway.savePcad('A.pcad', new Uint8Array(0), false)).toBe('A.pcad');
    expect(api.beginPcadSave).toHaveBeenCalledExactlyOnceWith('A.pcad', false, 'part', 0);
    expect(sent).toEqual([]);
    expect(api.commitPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
  });

  it('途中の送信が失敗したら残りを送らず、取消を呼んで失敗をそのまま返す', async () => {
    const { api, sent, gateway } = transferApi({ chunkBytes: 4, failAt: 1 });
    await expect(gateway.savePcad('A.pcad', whole, true)).rejects.toThrow('disk full');
    expect(sent.map(row => row.index)).toEqual([0, 1]);
    expect(api.commitPcadSave).not.toHaveBeenCalled();
    expect(api.abortPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
    expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('本体が1回分を受けなかった(trueでない)ら残りを送らず、取消を呼んで保存の失敗にする', async () => {
    const { api, sent, gateway } = transferApi({ chunkBytes: 4, refuseAt: 0 });
    await expect(gateway.savePcad('A.pcad', whole, true)).rejects.toThrow('file.saveFailed');
    expect(sent.map(row => row.index)).toEqual([0]);
    expect(api.commitPcadSave).not.toHaveBeenCalled();
    expect(api.abortPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
  });

  it('確定が失敗したら取消を呼び、本体の文(控えの印を含む)をそのまま返す', async () => {
    const failure = new Error("Error invoking remote method 'pcad:saveCommit': Error: PCAD_SAVE_RECOVERY_COPY: 控えを残しました");
    const { api, gateway } = transferApi({ commit: () => Promise.reject(failure) });
    await expect(gateway.savePcad('A.pcad', whole, true)).rejects.toBe(failure);
    expect(api.abortPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
    expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('保存の窓を取り消したら(開始がnull)送らず、確定も取消もしない', async () => {
    const { api, sent, gateway } = transferApi({ begin: () => Promise.resolve(null) });
    expect(await gateway.savePcad('A.pcad', whole, true)).toBeNull();
    expect(sent).toEqual([]);
    expect(api.commitPcadSave).not.toHaveBeenCalled();
    expect(api.abortPcadSave).not.toHaveBeenCalled();
  });

  it.each([
    ['識別子が文字列でない', { transferId: 1, chunkBytes: 4 }],
    ['大きさが0', { transferId: 'transfer-1', chunkBytes: 0 }],
    ['大きさが整数でない', { transferId: 'transfer-1', chunkBytes: 1.5 }],
  ])('開始の答えの形が違えば(%s)送らずに保存の失敗にする', async (_label, receipt) => {
    const { sent, gateway } = transferApi({ begin: () => Promise.resolve(receipt) });
    await expect(gateway.savePcad('A.pcad', whole, true)).rejects.toThrow('file.saveFailed');
    expect(sent).toEqual([]);
  });

  it('部分の並びで受けても、全体と同じ大きさ・同じ切れ目・同じSHA-256で順に送る(部分の境目は切れ目とずらす)', async () => {
    const wholeSave = transferApi({ chunkBytes: 4 });
    expect(await wholeSave.gateway.savePcad('A.pcad', whole, true, 'part')).toBe('A.pcad');
    const parts = [Uint8Array.of(1, 2, 3), new Uint8Array(0), Uint8Array.of(4, 5, 6, 7, 8, 9), Uint8Array.of(10)];
    const before = parts.map(part => [...part]);
    const split = transferApi({ chunkBytes: 4 });
    expect(await split.gateway.savePcadParts?.('A.pcad', parts, true, 'part')).toBe('A.pcad');
    expect(split.api.beginPcadSave.mock.calls).toEqual(wholeSave.api.beginPcadSave.mock.calls);
    expect(split.sent.map(row => [row.index, [...row.bytes], row.digest]))
      .toEqual(wholeSave.sent.map(row => [row.index, [...row.bytes], row.digest]));
    for (const row of split.sent) {
      // 各回はその回の長さだけの独立した並び。部分の領域の見せ方や、全体の大きさの並びを送らない。
      expect(row.bytes.buffer.byteLength).toBe(row.bytes.byteLength);
      expect(parts.some(part => part.buffer === row.bytes.buffer)).toBe(false);
      expect(row.digest).toBe(await hex(row.bytes));
    }
    expect(parts.map(part => [...part])).toEqual(before);
    expect(split.api.commitPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
    expect(split.gateway.hasSaveTarget()).toBe(true);
  });

  it('部分の並びの途中の送信が失敗したら残りを送らず、取消を呼んで失敗をそのまま返す', async () => {
    const { api, sent, gateway } = transferApi({ chunkBytes: 4, failAt: 1 });
    await expect(gateway.savePcadParts?.('A.pcad', [whole.subarray(0, 5), whole.subarray(5)], true))
      .rejects.toThrow('disk full');
    expect(sent.map(row => row.index)).toEqual([0, 1]);
    expect(api.beginPcadSave).toHaveBeenCalledExactlyOnceWith('A.pcad', true, 'part', 10);
    expect(api.commitPcadSave).not.toHaveBeenCalled();
    expect(api.abortPcadSave).toHaveBeenCalledExactlyOnceWith('transfer-1');
    expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('旧い一括の口(savePcad)だけを出す preload は保存の口として受けない', () => {
    expect(createDesktopFileGateway({ pointercadDesktop: {
      openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => Promise.resolve(false),
    } })).toBeNull();
  });
});

describe('「開く」のバイト列は本体が決めた大きさに区切って受け取り、主世界の 1 本へ組む', () => {
  function openApi(options: { size?: number; chunkBytes?: number; pieces?: unknown[]; begin?: () => Promise<unknown>;
    chunk?: (readId: string, index: number) => Promise<unknown>; finish?: () => Promise<unknown> } = {}) {
    const size = options.size ?? 10;
    const ports = openPorts(options.begin ?? (() => Promise.resolve({ readId: 'read-1', name: 'A.pcad', size, chunkBytes: options.chunkBytes ?? 4 })));
    const pieces = options.pieces ?? [Uint8Array.of(1, 2, 3, 4), Uint8Array.of(5, 6, 7, 8), Uint8Array.of(9, 10)];
    ports.readPcadOpenChunk.mockImplementation(options.chunk ?? ((_readId: string, index: number) => Promise.resolve(pieces[index])));
    if (options.finish !== undefined) ports.finishPcadOpen.mockImplementation(options.finish);
    const api = { ...ports, confirmSaveTarget: () => Promise.resolve(true), clearSaveTarget: () => Promise.resolve(undefined),
      ...savePorts(() => Promise.resolve(null)), hasSaveTarget: () => Promise.resolve(false) };
    const gateway = createDesktopFileGateway({ pointercadDesktop: api });
    if (gateway === null) throw new Error('区切って読む口を持つ preload の gateway が必要');
    return { api, gateway, pieces };
  }

  it('開始の答えの大きさで順に区切って読み、1 本の並びへ組み、終わりの候補を返す', async () => {
    const { api, gateway, pieces } = openApi();
    const opened = await gateway.openPcad('all');
    expect(api.beginPcadOpen).toHaveBeenCalledExactlyOnceWith('all');
    expect(api.readPcadOpenChunk.mock.calls).toEqual([['read-1', 0], ['read-1', 1], ['read-1', 2]]);
    expect(api.finishPcadOpen).toHaveBeenCalledExactlyOnceWith('read-1');
    expect(api.abortPcadOpen).not.toHaveBeenCalled();
    expect(opened?.name).toBe('A.pcad');
    expect(opened?.saveTargetToken).toBe('save-target-1');
    // 組んだ並びはこの「開く」のためだけの物で、読込の Worker へ写さずに移してよい印を付ける(案2)。
    expect(opened?.owned).toBe(true);
    expect([...(opened?.bytes ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 区切りを並べた 1 本の並び(全域)で、どの区切りの領域とも別。
    expect(opened?.bytes.byteOffset).toBe(0);
    expect(opened?.bytes.buffer.byteLength).toBe(10);
    for (const piece of pieces) expect(piece instanceof Uint8Array && piece.buffer !== opened?.bytes.buffer).toBe(true);
    // 「開く」は上書き先を変えない(文書の検証の後の確定で変える)。
    expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('空のファイル(0バイト)は区切りを読まずに終わる', async () => {
    const { api, gateway } = openApi({ size: 0 });
    const opened = await gateway.openPcad('part');
    expect(api.readPcadOpenChunk).not.toHaveBeenCalled();
    expect(api.finishPcadOpen).toHaveBeenCalledExactlyOnceWith('read-1');
    expect(opened?.bytes.byteLength).toBe(0);
  });

  it.each([
    ['短い', [Uint8Array.of(1, 2, 3)]],
    ['長い', [Uint8Array.of(1, 2, 3, 4, 5)]],
    ['バイト列でない', ['not-bytes']],
  ])('区切りの長さが期待と違えば(%s)残りを読まず、取消を呼んで開く失敗にする', async (_label, pieces) => {
    const { api, gateway } = openApi({ pieces });
    await expect(gateway.openPcad('part')).rejects.toThrow('file.openFailed');
    expect(api.readPcadOpenChunk).toHaveBeenCalledTimes(1);
    expect(api.finishPcadOpen).not.toHaveBeenCalled();
    expect(api.abortPcadOpen).toHaveBeenCalledExactlyOnceWith('read-1');
  });

  it('途中の区切りの読みが失敗したら残りを読まず、取消を呼んで失敗を返す', async () => {
    const { api, gateway } = openApi({ chunk: (_readId, index) => index === 1 ? Promise.reject(new Error('EIO')) : Promise.resolve(Uint8Array.of(1, 2, 3, 4)) });
    await expect(gateway.openPcad('part')).rejects.toThrow('EIO');
    expect(api.readPcadOpenChunk).toHaveBeenCalledTimes(2);
    expect(api.finishPcadOpen).not.toHaveBeenCalled();
    expect(api.abortPcadOpen).toHaveBeenCalledExactlyOnceWith('read-1');
  });

  it('終わりが大きさの変化で断られたら、Web版と同じfile.error.corruptedにして取消を呼ぶ', async () => {
    const { api, gateway } = openApi({ finish: () => Promise.reject(new Error(
      "Error invoking remote method 'pcad:openFinish': Error: PCAD_READ_SIZE_CHANGED: 読込中にファイルが変わりました。")) });
    await expect(gateway.openPcad('part')).rejects.toThrow('file.error.corrupted');
    expect(api.abortPcadOpen).toHaveBeenCalledExactlyOnceWith('read-1');
  });

  it('終わりの答えが文字列でなければ開く失敗にする', async () => {
    const { gateway } = openApi({ finish: () => Promise.resolve(null) });
    await expect(gateway.openPcad('part')).rejects.toThrow('file.openFailed');
  });

  it('窓を取り消したら(開始がnull)読まず、終わりも取消も呼ばない', async () => {
    const { api, gateway } = openApi({ begin: () => Promise.resolve(null) });
    expect(await gateway.openPcad('part')).toBeNull();
    expect(api.readPcadOpenChunk).not.toHaveBeenCalled();
    expect(api.finishPcadOpen).not.toHaveBeenCalled();
    expect(api.abortPcadOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['識別子が文字列でない', { readId: 1, name: 'A.pcad', size: 3, chunkBytes: 4 }, false],
    ['名前が無い', { readId: 'read-1', size: 3, chunkBytes: 4 }, true],
    ['大きさが負', { readId: 'read-1', name: 'A.pcad', size: -1, chunkBytes: 4 }, true],
    ['大きさが整数でない', { readId: 'read-1', name: 'A.pcad', size: 1.5, chunkBytes: 4 }, true],
    ['分ける大きさが0', { readId: 'read-1', name: 'A.pcad', size: 3, chunkBytes: 0 }, true],
  ])('開始の答えの形が違えば(%s)読まずに開く失敗にし、識別子があれば取消を呼ぶ', async (_label, receipt, aborts) => {
    const { api, gateway } = openApi({ begin: () => Promise.resolve(receipt) });
    await expect(gateway.openPcad('part')).rejects.toThrow('file.openFailed');
    expect(api.readPcadOpenChunk).not.toHaveBeenCalled();
    expect(api.abortPcadOpen).toHaveBeenCalledTimes(aborts ? 1 : 0);
  });

  it('読み直しは開いた時の候補の token で同じ口を区切って読み直し、終わりが同じ token の時だけ中身を返す', async () => {
    const { api, gateway } = openApi();
    const opened = await gateway.openPcad('part');
    api.rereadPcadOpen.mockResolvedValueOnce({ readId: 'read-2', name: 'A.pcad', size: 10, chunkBytes: 4 });
    const again = await opened?.reread?.();
    expect(api.rereadPcadOpen).toHaveBeenCalledExactlyOnceWith('save-target-1');
    expect(api.readPcadOpenChunk.mock.calls.slice(3)).toEqual([['read-2', 0], ['read-2', 1], ['read-2', 2]]);
    expect(api.finishPcadOpen).toHaveBeenLastCalledWith('read-2');
    expect([...(again ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(again?.buffer).not.toBe(opened?.bytes.buffer);
    expect(api.abortPcadOpen).not.toHaveBeenCalled();
  });

  it.each([
    ['本体が断った(開いた後にファイルが変わった)', 'reject'],
    ['終わりが別の token', 'otherToken'],
    ['開始の答えの形が違う', 'malformed'],
  ])('読み直しが失敗したら(%s)中身を返さず、途中なら取消を呼ぶ', async (_label, failure) => {
    const { api, gateway } = openApi();
    const opened = await gateway.openPcad('part');
    if (failure === 'reject') api.rereadPcadOpen.mockRejectedValueOnce(new Error(
      "Error invoking remote method 'pcad:openReread': Error: PCAD_READ_SIZE_CHANGED: 読込中にファイルが変わりました。"));
    else api.rereadPcadOpen.mockResolvedValueOnce(failure === 'malformed' ? { readId: 'read-2', name: 'A.pcad', size: -1, chunkBytes: 4 }
      : { readId: 'read-2', name: 'A.pcad', size: 10, chunkBytes: 4 });
    if (failure === 'otherToken') api.finishPcadOpen.mockResolvedValueOnce('save-target-2');
    await expect(opened?.reread?.()).rejects.toThrow(failure === 'reject' ? 'file.error.corrupted' : 'file.openFailed');
    expect(api.abortPcadOpen).toHaveBeenCalledTimes(failure === 'malformed' ? 1 : 0);
  });

  it('旧い一括の口(openPcad)だけを出す preload は「開く」の口として受けない', () => {
    expect(createDesktopFileGateway({ pointercadDesktop: {
      openPcad: () => Promise.resolve(null), confirmSaveTarget: () => Promise.resolve(true),
      clearSaveTarget: () => Promise.resolve(undefined), ...savePorts(() => Promise.resolve(null)),
      hasSaveTarget: () => Promise.resolve(false),
    } })).toBeNull();
  });
});
