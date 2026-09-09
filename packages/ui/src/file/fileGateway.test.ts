/**
 * ファイルの読み書きの口のうち、ブラウザに触らない部分の検査
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク23 手順7)。
 *
 * ここで確かめるのは「候補名の付け方」と「File System Access API があるかの判定」、
 * それに種類つきの出し入れ(`openFile` / `saveFileAs`。P6 計画書 タスク4)。
 * 本物の窓・ダウンロード・書き込みは本物のブラウザでしか動かないので、通しの確認は
 * E2E(タスク27・タスク44)と統括の目視に任せ、ここでは**偽の相手**(`showOpenFilePicker` /
 * `showSaveFilePicker` / `document` / `URL` だけを持つ入れ物)を渡して、
 * 「何が渡ったか」「何を呼んだか」「上書き先を覚えていないか」を見る。
 * 本物の `globalThis` へ欄を差し込むと他の検査へ漏れるので、必ず偽の相手を渡す。
 */

import { FILE_KINDS } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  acceptAttributeFor,
  createBrowserFileGateway,
  extensionsOf,
  fileKindOfName,
  hasFileSystemAccess,
  openFileInBrowser,
  openFileThrough,
  PCAD_EXTENSION,
  saveFileAsInBrowser,
  saveFileAsThrough,
  withPcadExtension,
  withPcadaExtension,
  type FileGateway,
  type PickedFile,
} from './fileGateway.js';

describe('保存の候補名(.pcad の補完)', () => {
  it('拡張子が無ければ .pcad を足す', () => {
    expect(withPcadExtension('部品1')).toBe('部品1.pcad');
  });

  it('すでに .pcad で終わっていれば足さない', () => {
    expect(withPcadExtension('部品1.pcad')).toBe('部品1.pcad');
  });

  it('大文字の .PCAD も同じ拡張子として扱う(二重に付けない)', () => {
    expect(withPcadExtension('部品1.PCAD')).toBe('部品1.PCAD');
  });

  it('別の拡張子は残したまま .pcad を足す(取り違えを防ぐ)', () => {
    expect(withPcadExtension('メモ.txt')).toBe('メモ.txt.pcad');
  });

  it('前後の空白は落とす', () => {
    expect(withPcadExtension('  部品1  ')).toBe('部品1.pcad');
  });

  it('拡張子の綴りは 1 箇所で決まっている', () => {
    expect(PCAD_EXTENSION).toBe('.pcad');
    expect(withPcadExtension('a').endsWith(PCAD_EXTENSION)).toBe(true);
  });
});

describe('File System Access API の判定', () => {
  it('2 つとも揃っていれば使える', () => {
    const scope = {
      showOpenFilePicker: () => Promise.resolve([]),
      showSaveFilePicker: () => Promise.resolve({}),
    };
    expect(hasFileSystemAccess(scope)).toBe(true);
  });

  it('欄が無ければ使えない', () => {
    expect(hasFileSystemAccess({})).toBe(false);
  });

  it('片方だけでは使えない(環境ごとに振る舞いが変わらないようにする)', () => {
    expect(hasFileSystemAccess({ showOpenFilePicker: () => Promise.resolve([]) })).toBe(false);
    expect(hasFileSystemAccess({ showSaveFilePicker: () => Promise.resolve({}) })).toBe(false);
  });

  it('欄はあっても関数でなければ使えない', () => {
    expect(hasFileSystemAccess({ showOpenFilePicker: 1, showSaveFilePicker: 'yes' })).toBe(false);
  });

  it('Node のように何も持たない環境(この検査自身)では使えないと答える', () => {
    expect(hasFileSystemAccess()).toBe(false);
  });
});

describe('ブラウザ用の口', () => {
  it('assembly の開くは .pcada を選び、token の検証後だけ上書き先になる', async () => {
    const fake = createSaveTargetOpenScope(['A.pcada']);
    const gateway = createBrowserFileGateway(fake.scope);
    const picked = await gateway.openPcad('assembly');
    expect(picked?.name).toBe('A.pcada');
    expect(gateway.hasSaveTarget()).toBe(false);
    if (picked?.saveTargetToken == null) throw new Error('token required');
    await gateway.confirmSaveTarget?.(picked.saveTargetToken);
    expect(gateway.hasSaveTarget()).toBe(true);
  });

  it('一般の開くは3種の文書、assembly の保存は .pcada のフィルタを渡す', async () => {
    const opened = createFakeOpenScope('a.pcada', Uint8Array.of(1));
    await createBrowserFileGateway(opened.scope).openPcad('all');
    expect(opened.options[0].types?.flatMap((type) => Object.values(type.accept).flat())).toEqual(['.pcad', '.pcada', '.pcadd']);
    const saved = createFakeSaveScope('a.pcada');
    const gateway = createBrowserFileGateway(saved.scope);
    await gateway.savePcad('a.pcada', Uint8Array.of(1), false, 'assembly');
    expect(saved.options[0].types?.[0].accept).toEqual({ 'application/octet-stream': ['.pcada'] });
    expect(withPcadaExtension(' a.PCADA ')).toBe('a.PCADA');
    expect(withPcadaExtension('a')).toBe('a.pcada');
  });

  it('assembly の控えの書き出しでは通常の保存先を変えない', async () => {
    const fake = createFakeSaveScope('recovery.pcada');
    const gateway = createBrowserFileGateway(fake.scope);
    expect(await saveFileAsThrough(gateway, 'recovery.pcada', 'pcada', Uint8Array.of(1))).toBe(true);
    expect(gateway.hasSaveTarget()).toBe(false);
  });
  it('作った直後は保存先を覚えていない(はじめの保存は必ず場所を聞く)', () => {
    expect(createBrowserFileGateway().hasSaveTarget()).toBe(false);
  });

  it('作り直すと別の口になる(保存先を引きずらない)', () => {
    expect(createBrowserFileGateway()).not.toBe(createBrowserFileGateway());
  });

  it('開いただけでは保存先にならず、token を確定した後だけ保存先になる', async () => {
    const fake = createSaveTargetOpenScope(['A.pcad']);
    const gateway = createBrowserFileGateway(fake.scope);
    const picked = await gateway.openPcad();

    expect(gateway.hasSaveTarget()).toBe(false);
    if (
      picked === null ||
      picked.saveTargetToken === null ||
      gateway.confirmSaveTarget === undefined
    ) {
      throw new Error('保存先候補が返りませんでした');
    }
    await gateway.confirmSaveTarget(picked.saveTargetToken);
    expect(gateway.hasSaveTarget()).toBe(true);
  });

  it('次の「開く」を始めると、前の未確定 token は使えなくなる', async () => {
    const fake = createSaveTargetOpenScope(['A.pcad', 'B.pcad']);
    const gateway = createBrowserFileGateway(fake.scope);
    const a = await gateway.openPcad();
    const b = await gateway.openPcad();
    if (
      a === null ||
      a.saveTargetToken === null ||
      b === null ||
      b.saveTargetToken === null ||
      gateway.confirmSaveTarget === undefined
    ) {
      throw new Error('保存先候補が返りませんでした');
    }

    await gateway.confirmSaveTarget(a.saveTargetToken);
    expect(gateway.hasSaveTarget()).toBe(false);
    await gateway.confirmSaveTarget(b.saveTargetToken);
    expect(gateway.hasSaveTarget()).toBe(true);
  });

  it('解除すると、確定済みの保存先も未確定の候補も使えなくなる', async () => {
    const fake = createSaveTargetOpenScope(['A.pcad', 'B.pcad']);
    const gateway = createBrowserFileGateway(fake.scope);
    const a = await gateway.openPcad();
    if (
      a === null ||
      a.saveTargetToken === null ||
      gateway.confirmSaveTarget === undefined ||
      gateway.clearSaveTarget === undefined
    ) {
      throw new Error('保存先を操作する口がありませんでした');
    }
    await gateway.confirmSaveTarget(a.saveTargetToken);
    gateway.clearSaveTarget();
    expect(gateway.hasSaveTarget()).toBe(false);

    const b = await gateway.openPcad();
    if (b === null || b.saveTargetToken === null) {
      throw new Error('保存先候補が返りませんでした');
    }
    gateway.clearSaveTarget();
    await gateway.confirmSaveTarget(b.saveTargetToken);
    expect(gateway.hasSaveTarget()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 種類つきの出し入れ(計画書 docs/plans/P6-入出力.md タスク4、§2.2、§0.a-0.4)
// ---------------------------------------------------------------------------

/** ファイル選択の窓へ渡された設定。使う欄だけを書き写したもの。 */
interface FakePickerOptions {
  readonly suggestedName?: string;
  readonly multiple?: boolean;
  readonly types?: readonly {
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

/** 窓を閉じた(取り消した)ときにブラウザが投げる失敗と同じ名前のもの。 */
function abortError(): Error {
  const error = new Error('取り消しました');
  error.name = 'AbortError';
  return error;
}

/** 渡された並びの写しを、共有していない `ArrayBuffer` として返す。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** 「保存する」の窓を持つ偽の相手。渡された設定と書かれたバイト列を覚える。 */
function createFakeSaveScope(savedName = '出力.stl'): {
  readonly scope: object;
  readonly options: readonly FakePickerOptions[];
  readonly written: readonly Uint8Array[];
} {
  const options: FakePickerOptions[] = [];
  const written: Uint8Array[] = [];
  const scope = {
    showSaveFilePicker(given: FakePickerOptions): Promise<unknown> {
      options.push(given);
      return Promise.resolve({
        name: savedName,
        createWritable: (): Promise<unknown> =>
          Promise.resolve({
            write: (data: Uint8Array): Promise<void> => {
              written.push(data);
              return Promise.resolve();
            },
            close: (): Promise<void> => Promise.resolve(),
          }),
      });
    },
  };
  return { scope, options, written };
}

/** 「開く」の窓を持つ偽の相手。 */
function createFakeOpenScope(
  fileName: string,
  bytes: Uint8Array,
): { readonly scope: object; readonly options: readonly FakePickerOptions[] } {
  const options: FakePickerOptions[] = [];
  const scope = {
    showOpenFilePicker(given: FakePickerOptions): Promise<unknown> {
      options.push(given);
      return Promise.resolve([
        {
          name: fileName,
          getFile: (): Promise<unknown> =>
            Promise.resolve({ arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(toArrayBuffer(bytes)) }),
        },
      ]);
    },
  };
  return { scope, options };
}

/** `.pcad` の「開く」が返す書き込み可能な handle を順に作る偽の相手。 */
function createSaveTargetOpenScope(fileNames: readonly string[]): { readonly scope: object } {
  const remaining = [...fileNames];
  const scope = {
    showOpenFilePicker(): Promise<unknown> {
      const name = remaining.shift();
      if (name === undefined) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          name,
          getFile: (): Promise<unknown> =>
            Promise.resolve({ arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(0)) }),
          createWritable: (): Promise<unknown> =>
            Promise.resolve({
              write: (): Promise<void> => Promise.resolve(),
              close: (): Promise<void> => Promise.resolve(),
            }),
        },
      ]);
    },
  };
  return { scope };
}

/** ダウンロードの出口だけを持つ偽の相手(File System Access API は無い)。 */
function createFakeDownloadScope(): {
  readonly scope: object;
  readonly log: readonly string[];
  readonly anchor: { href: string; download: string; hidden: boolean };
} {
  const log: string[] = [];
  const anchor = {
    href: '',
    download: '',
    hidden: false,
    click(): void {
      log.push('click');
    },
    remove(): void {
      log.push('remove');
    },
  };
  const scope = {
    document: {
      createElement(tagName: string): unknown {
        log.push(`createElement:${tagName}`);
        return anchor;
      },
      body: {
        append(): void {
          log.push('append');
        },
      },
    },
    URL: {
      createObjectURL(): string {
        log.push('createObjectURL');
        return 'blob:偽の場所';
      },
      revokeObjectURL(url: string): void {
        log.push(`revokeObjectURL:${url}`);
      },
    },
  };
  return { scope, log, anchor };
}

describe('ファイルの種類ごとの拡張子と MIME 型の表', () => {
  it('すべての種類に拡張子が 1 つ以上ある(表に穴が無い)', () => {
    for (const kind of FILE_KINDS) {
      expect(extensionsOf(kind).length).toBeGreaterThan(0);
    }
  });

  it('部品ファイルの拡張子は表からも同じものが出る', () => {
    expect(extensionsOf('pcad')).toEqual([PCAD_EXTENSION]);
    expect(extensionsOf('pcadt')).toEqual(['.pcadt']);
  });

  it('STEP は .step と .stp の 2 つを名乗る', () => {
    expect(extensionsOf('step')).toEqual(['.step', '.stp']);
  });

  it('glTF は .glb と .gltf の 2 つを名乗る(バイナリと JSON)', () => {
    expect(extensionsOf('glb')).toEqual(['.glb', '.gltf']);
  });

  it('選択の窓の accept は頼んだ種類の拡張子を順に並べる', () => {
    expect(acceptAttributeFor(['step', 'stl'])).toBe('.step,.stp,.stl');
  });

  it('拡張子からその種類を選び直せる(大文字小文字は問わない)', () => {
    expect(fileKindOfName('部品.STP', ['step', 'stl'])).toBe('step');
    expect(fileKindOfName('部品.stl', ['step', 'stl'])).toBe('stl');
  });

  it('頼んでいない種類には答えない(取り違えを防ぐ)', () => {
    expect(fileKindOfName('図面.dxf', ['step', 'stl'])).toBeNull();
  });

  it('見覚えのない拡張子には答えない', () => {
    expect(fileKindOfName('メモ.txt', FILE_KINDS)).toBeNull();
  });
});

describe('種類を選んで開く(openFile)', () => {
  it('選択の窓に頼んだ種類の拡張子が渡り、種類つきで返る', async () => {
    const fake = createFakeOpenScope('部品.stp', new Uint8Array([1, 2, 3]));
    const picked = await openFileInBrowser(['step', 'stl'], fake.scope);

    expect(picked).not.toBeNull();
    expect(picked?.kind).toBe('step');
    expect(picked?.fileName).toBe('部品.stp');
    expect(picked?.bytes).toEqual(new Uint8Array([1, 2, 3]));

    const types = fake.options[0]?.types ?? [];
    expect(types.flatMap((type) => Object.values(type.accept).flat())).toEqual([
      '.step',
      '.stp',
      '.stl',
    ]);
  });

  it('取り消したら null を返す(例外を投げない)', async () => {
    const scope = {
      showOpenFilePicker: (): Promise<unknown> => Promise.reject(abortError()),
    };
    expect(await openFileInBrowser(['step'], scope)).toBeNull();
  });

  it('何も選ばれなかったときも null を返す', async () => {
    const scope = { showOpenFilePicker: (): Promise<unknown> => Promise.resolve([]) };
    expect(await openFileInBrowser(['step'], scope)).toBeNull();
  });

  it('頼んだ種類のどれでもないファイルは断る(どの形式として読むか決められない)', async () => {
    const fake = createFakeOpenScope('メモ.txt', new Uint8Array([1]));
    await expect(openFileInBrowser(['step'], fake.scope)).rejects.toThrow();
  });

  it('開いても部品の上書き先は覚えない(hasSaveTarget は false のまま)', async () => {
    const fake = createFakeOpenScope('部品.stl', new Uint8Array([1]));
    const gateway = createBrowserFileGateway(fake.scope);

    expect(await openFileThrough(gateway, ['stl'])).not.toBeNull();
    expect(gateway.hasSaveTarget()).toBe(false);
  });
});

describe('名前を訊いて書き出す(saveFileAs)', () => {
  it('保存の窓が呼ばれ、名前と種類の拡張子が渡り、バイト列が書かれる', async () => {
    const fake = createFakeSaveScope();
    const bytes = new Uint8Array([7, 8, 9]);

    expect(await saveFileAsInBrowser('部品.3mf', '3mf', bytes, fake.scope)).toBe(true);
    expect(fake.options[0]?.suggestedName).toBe('部品.3mf');
    expect(fake.options[0]?.types?.flatMap((type) => Object.values(type.accept).flat())).toEqual([
      '.3mf',
    ]);
    expect(fake.written).toEqual([bytes]);
  });

  it('2 回続けて書き出すと 2 回とも名前を訊く(上書き先を覚えない)', async () => {
    const fake = createFakeSaveScope();
    const gateway = createBrowserFileGateway(fake.scope);

    expect(await saveFileAsThrough(gateway, '部品.stl', 'stl', new Uint8Array([1]))).toBe(true);
    expect(await saveFileAsThrough(gateway, '部品.stl', 'stl', new Uint8Array([2]))).toBe(true);
    expect(fake.options).toHaveLength(2);
  });

  it('書き出しても部品の上書き先は覚えない(hasSaveTarget は false のまま)', async () => {
    const fake = createFakeSaveScope();
    const gateway = createBrowserFileGateway(fake.scope);

    await saveFileAsThrough(gateway, '部品.stl', 'stl', new Uint8Array([1]));
    expect(gateway.hasSaveTarget()).toBe(false);
  });

  it('取り消したら false を返す(例外を投げない)', async () => {
    const scope = {
      showSaveFilePicker: (): Promise<unknown> => Promise.reject(abortError()),
    };
    expect(await saveFileAsInBrowser('部品.stl', 'stl', new Uint8Array([1]), scope)).toBe(false);
  });

  it('保存の窓が無ければダウンロードへ落ち、一時的な場所を必ず手放す', async () => {
    const fake = createFakeDownloadScope();

    expect(await saveFileAsInBrowser('部品.glb', 'glb', new Uint8Array([1, 2]), fake.scope)).toBe(
      true,
    );
    expect(fake.anchor.download).toBe('部品.glb');
    expect(fake.log).toEqual([
      'createObjectURL',
      'createElement:a',
      'append',
      'click',
      'remove',
      'revokeObjectURL:blob:偽の場所',
    ]);
  });
});

describe('差し込まれた口を通す(openFileThrough / saveFileAsThrough)', () => {
  /** 種類つきの口を持たない、古い差し替え(P2 のままの口)。 */
  const oldGateway: FileGateway = {
    openPcad: (): Promise<PickedFile | null> => Promise.resolve(null),
    savePcad: (): Promise<string | null> => Promise.resolve(null),
    hasSaveTarget: (): boolean => false,
  };

  it('口が種類つきの書き出しを持っていればそれを呼ぶ', async () => {
    const calls: { fileName: string; kind: string }[] = [];
    const gateway: FileGateway = {
      ...oldGateway,
      saveFileAs: (fileName, kind): Promise<boolean> => {
        calls.push({ fileName, kind });
        return Promise.resolve(true);
      },
    };

    expect(await saveFileAsThrough(gateway, '部品.dxf', 'dxf', new Uint8Array([1]))).toBe(true);
    expect(calls).toEqual([{ fileName: '部品.dxf', kind: 'dxf' }]);
  });

  it('口が種類つきの読み込みを持っていればそれを呼ぶ', async () => {
    const asked: string[][] = [];
    const gateway: FileGateway = {
      ...oldGateway,
      openFile: (kinds): Promise<null> => {
        asked.push([...kinds]);
        return Promise.resolve(null);
      },
    };

    expect(await openFileThrough(gateway, ['step', 'obj'])).toBeNull();
    expect(asked).toEqual([['step', 'obj']]);
  });

  it('持っていない口はブラウザ用の実装へ落ちる(Node には出口が無いので断る)', async () => {
    await expect(
      saveFileAsThrough(oldGateway, '部品.stl', 'stl', new Uint8Array([1])),
    ).rejects.toThrow();
  });
});
