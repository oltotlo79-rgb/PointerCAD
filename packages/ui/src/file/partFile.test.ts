/**
 * 新規・開く・保存の検査(計画書 docs/plans/P2-ソリッド基礎.md タスク23 手順7、
 * 「検証」の表)。
 *
 * ブラウザの API は使わない。ファイルを選ぶ・読む・書くはすべて**偽の口**に差し替え、
 * 記憶上のバイト列で往復させる。確かめるのは次の 3 つ。
 *  - 保存して開き直すと元の部品に戻る(FR-801)。
 *  - 読めなかったとき・取り消されたときに**今の文書を壊さない**(NFR-RE-1)。
 *  - 失うものがある操作の前に確認する(NFR-UX-3)。
 */

import {
  PCAD_SCHEMA_VERSION,
  SCHEMA_MIGRATIONS,
  readPcadFile,
  writePcadFile,
  type AutoSaver,
  type ImportedMeshBytes,
  type PcadAttachments,
} from '@pointercad/io';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptyPartDocument,
  createEmptySketchDocument,
  createPointFeature,
  replaceSketch,
  type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInitialDocumentState, useAppStore } from '../store/useAppStore.js';
import type { FileGateway, PickedFile } from './fileGateway.js';
import {
  displayFileName,
  documentLabel,
  hasUnsavedChanges,
  newPart,
  openPart,
  savePart,
  windowTitle,
  type PartFileDeps,
} from './partFile.js';
import { loadRecentFiles, type RecentFilesStorage } from './recentFiles.js';

interface SaveCall {
  readonly suggestedName: string;
  readonly bytes: Uint8Array;
  readonly saveAs: boolean;
}

interface FakeOptions {
  /** 保存できたときに返す名前。既定は渡された候補名。 */
  readonly savedName?: string;
  /** 保存を取り消す。 */
  readonly saveCancels?: boolean;
  /** 保存が失敗する。 */
  readonly saveThrows?: boolean;
  /** 開くのを取り消す。 */
  readonly openCancels?: boolean;
  /** 開くのが失敗する。 */
  readonly openThrows?: boolean;
  /** 記憶上のファイルの代わりに、このバイト列を返す(壊れたファイルの検査に使う)。 */
  readonly openBytes?: Uint8Array;
  /** `openBytes` を返すときの名前。 */
  readonly openName?: string;
}

interface FakeGateway {
  readonly gateway: FileGateway;
  readonly saveCalls: readonly SaveCall[];
  /** 記憶上のファイル。`savePcad` が書き、`openPcad` が読む。 */
  readonly stored: () => PickedFile | null;
}

/** 記憶上のバイト列だけを扱う偽の口。ブラウザには触らない。 */
function createFakeGateway(options: FakeOptions = {}): FakeGateway {
  const saveCalls: SaveCall[] = [];
  let stored: PickedFile | null = null;

  const gateway: FileGateway = {
    openPcad(): Promise<PickedFile | null> {
      if (options.openThrows === true) {
        return Promise.reject(new Error('開けませんでした'));
      }
      if (options.openCancels === true) {
        return Promise.resolve(null);
      }
      if (options.openBytes !== undefined) {
        return Promise.resolve({
          name: options.openName ?? 'こわれた部品.pcad',
          bytes: options.openBytes,
        });
      }
      return Promise.resolve(stored);
    },
    savePcad(suggestedName, bytes, saveAs): Promise<string | null> {
      saveCalls.push({ suggestedName, bytes, saveAs });
      if (options.saveThrows === true) {
        return Promise.reject(new Error('保存できませんでした'));
      }
      if (options.saveCancels === true) {
        return Promise.resolve(null);
      }
      const name = options.savedName ?? suggestedName;
      stored = { name, bytes };
      return Promise.resolve(name);
    },
    hasSaveTarget(): boolean {
      return stored !== null;
    },
  };

  return { gateway, saveCalls, stored: () => stored };
}

/** 何を答えたかを覚える確認の口。 */
interface FakeDeps {
  readonly deps: PartFileDeps;
  readonly confirmed: readonly string[];
}

/**
 * 偽の口。**履歴の置き場は既定で `null`**(どこにも残さない)にしてあるので、
 * 履歴を見ない検査は端末の `localStorage` を一切触らない(検査どうしが漏れ合わない)。
 */
function createFakeDeps(
  answer: boolean,
  thumbnail: Uint8Array | null = null,
  recentFilesStorage: RecentFilesStorage | null = null,
): FakeDeps {
  const confirmed: string[] = [];
  return {
    confirmed,
    deps: {
      captureThumbnail: () => thumbnail,
      confirmDiscard: (messageKey) => {
        confirmed.push(messageKey);
        return Promise.resolve(answer);
      },
      recentFilesStorage,
    },
  };
}

/** 記憶上だけの履歴の置き場(ブラウザには触れない)。 */
function createMemoryStorage(): RecentFilesStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/**
 * 名前ごとに中身を覚える偽の口(別名保存の検査に使う)。本物と同じく
 * **上書き先を覚え、`saveAs` が true のときだけ名前を訊き直す。**
 * 訊かれたときに答える名前は `setNextName` で決め、`null` を渡すと取り消しになる。
 */
interface NamedFakeGateway {
  readonly gateway: FileGateway;
  /** 記憶上のファイル(名前 → 中身)。 */
  readonly files: () => ReadonlyMap<string, Uint8Array>;
  readonly setNextName: (name: string | null) => void;
  /** 名前を訊かれた回数。 */
  readonly asked: () => number;
}

function createNamedGateway(): NamedFakeGateway {
  const files = new Map<string, Uint8Array>();
  let target: string | null = null;
  let answer: string | null = null;
  let asked = 0;

  const gateway: FileGateway = {
    openPcad(): Promise<PickedFile | null> {
      // この口は保存の検査にだけ使う(開くのは `createFakeGateway` が受け持つ)。
      return Promise.resolve(null);
    },
    savePcad(_suggestedName, bytes, saveAs): Promise<string | null> {
      // 別名保存(saveAs)と、まだ保存先を知らないときは名前を訊く。
      let name = saveAs ? null : target;
      if (name === null) {
        asked += 1;
        if (answer === null) {
          return Promise.resolve(null);
        }
        name = answer;
      }
      files.set(name, bytes);
      // 書けた先が次からの上書き先になる(本物の口もそう振る舞う、§0.a-0.37)。
      target = name;
      return Promise.resolve(name);
    },
    hasSaveTarget(): boolean {
      return target !== null;
    },
  };

  return {
    gateway,
    files: () => files,
    setNextName: (name) => {
      answer = name;
    },
    asked: () => asked,
  };
}

/** 控えを消した回数だけを数える偽の自動保存(タスク24)。 */
function createFakeAutoSaver(): { readonly saver: AutoSaver; readonly discards: () => number } {
  let discards = 0;
  return {
    saver: {
      markDirty: () => undefined,
      saveNow: () => Promise.resolve(),
      stop: () => undefined,
      readLatest: () => Promise.resolve(null),
      discard: () => {
        discards += 1;
        return Promise.resolve();
      },
    },
    discards: () => discards,
  };
}

/** 点を 1 つかいた部品。空の部品と中身が違うので「保存していない変更」になる。 */
function partWithPoint(): PartDocument {
  const sketch = createEmptySketchDocument();
  const drawn = appendFeature(sketch, createPointFeature(sketch, absoluteCoordinate(1, 2, 3)));
  return replaceSketch(createEmptyPartDocument(), drawn);
}

function useGateway(gateway: FileGateway): void {
  useAppStore.setState({ fileGateway: gateway });
}

function useFake(fake: FakeGateway): void {
  useGateway(fake.gateway);
}

/** 保存されたバイト列に入っていたサムネイル。入っていなければ undefined。 */
function thumbnailOf(picked: PickedFile | null): Uint8Array | undefined {
  if (picked === null) {
    throw new Error('まだ保存されていません');
  }
  const result = readPcadFile(picked.bytes);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.thumbnailPng;
}

/**
 * ZIP の中の入れ物の名前だけを書き換える。
 *
 * `packages/ui` は ZIP を作る道具(fflate)を依存に持たない(持たせるのは `packages/io`
 * の役目)ので、壊れ方の違うファイルは**正しい .pcad の名前を差し替えて**作る。
 * ZIP は名前そのものを検算しないので、同じ長さで書き換えれば中身は壊れない。
 */
function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) {
    throw new Error('置き換えは同じ長さでなければ ZIP の位置の記録が合わなくなります');
  }
  const target = [...from].map((character) => character.charCodeAt(0));
  const replacement = [...to].map((character) => character.charCodeAt(0));
  const copy = new Uint8Array(bytes);
  for (let start = 0; start + target.length <= copy.length; start += 1) {
    let hit = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (copy[start + offset] !== target[offset]) {
        hit = false;
        break;
      }
    }
    if (!hit) {
      continue;
    }
    for (let offset = 0; offset < replacement.length; offset += 1) {
      copy[start + offset] = replacement[offset];
    }
  }
  return copy;
}

/** 封筒の版だけを変えた .pcad。 */
function pcadWithSchema(schema: number): Uint8Array {
  return writePcadFile({ ...createEmptyPartDocument(), schemaVersion: schema });
}

/**
 * 移行が用意されていない、最も新しい「古すぎる版」(`SCHEMA_MIGRATIONS` の最小の鍵 − 1)。
 * `PCAD_SCHEMA_VERSION - 1` だと、版が上がるたびに新しい移行が足される版と重なってしまう
 * (P3 で版 2 → 3 の移行が増え、版 2 は「開ける版」になった)ので、移行表そのものから
 * 「開けない最も新しい版」を導く。
 */
const OLDEST_UNMIGRATABLE_SCHEMA_VERSION =
  Math.min(...Object.keys(SCHEMA_MIGRATIONS).map(Number)) - 1;

/** `document.json` が入っていない ZIP。 */
function zipWithoutDocument(): Uint8Array {
  return replaceAscii(writePcadFile(createEmptyPartDocument()), 'document.json', 'contents.json');
}

/**
 * 中身を好きな文字列に差し替えた .pcad。サムネイルは無圧縮で入るので、
 * サムネイルの場所へ文字列を入れ、名前を `document.json` へ付け替える。
 */
function pcadWithDocumentText(text: string): Uint8Array {
  const bytes = writePcadFile(createEmptyPartDocument(), {
    thumbnailPng: new TextEncoder().encode(text),
  });
  return replaceAscii(
    replaceAscii(bytes, 'document.json', 'contents.json'),
    'thumbnail.png',
    'document.json',
  );
}

beforeEach(() => {
  useAppStore.setState(createInitialDocumentState());
});

describe('表示用の名前', () => {
  it('まだ保存していなければ「名称未設定」(計画書の検証表)', () => {
    expect(displayFileName(null)).toBe('名称未設定');
  });

  it('保存してあればその名前をそのまま出す', () => {
    expect(displayFileName('部品1.pcad')).toBe('部品1.pcad');
  });

  it('空白だけの名前は「名称未設定」に落とす', () => {
    expect(displayFileName('   ')).toBe('名称未設定');
  });

  it('保存していない変更があると名前の右に印が付く', () => {
    expect(documentLabel(null, true)).toBe('名称未設定*');
    expect(documentLabel('部品1.pcad', true)).toBe('部品1.pcad*');
    expect(documentLabel('部品1.pcad', false)).toBe('部品1.pcad');
  });

  it('窓の見出しは、名前も変更も無いうちは製品名だけ', () => {
    expect(windowTitle(null, false)).toBe('PointerCAD');
    expect(windowTitle(null, true)).toBe('名称未設定* - PointerCAD');
    expect(windowTitle('部品1.pcad', false)).toBe('部品1.pcad - PointerCAD');
  });
});

describe('保存していない変更があるか', () => {
  it('起動直後の空の部品は「変更なし」(まだ何もしていない)', () => {
    expect(hasUnsavedChanges(createEmptyPartDocument(), null)).toBe(false);
  });

  it('何かかいた後は「変更あり」', () => {
    expect(hasUnsavedChanges(partWithPoint(), null)).toBe(true);
  });

  it('中身が同じなら別の入れ物でも「変更なし」(参照では比べない)', () => {
    expect(hasUnsavedChanges(partWithPoint(), partWithPoint())).toBe(false);
  });

  it('保存した後に文書を変えれば「変更あり」', () => {
    const saved = createEmptyPartDocument();
    expect(hasUnsavedChanges(partWithPoint(), saved)).toBe(true);
  });
});

describe('保存する(FR-806、FR-801)', () => {
  it('保存して開き直すと元の部品に戻り、ファイル名が入る', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    const document = partWithPoint();
    useAppStore.getState().applyDocument(document);

    await savePart(createFakeDeps(true).deps, false);
    expect(useAppStore.getState().fileName).toBe('部品1.pcad');

    // 別の部品を開いている状態から読み直しても、元の中身に戻る。
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    useAppStore.getState().setFileState(null, null);
    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toEqual(document);
    expect(state.fileName).toBe('部品1.pcad');
  });

  it('保存した直後は「保存していない変更」が無くなる', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    const state = useAppStore.getState();
    expect(hasUnsavedChanges(state.document, state.savedDocument)).toBe(false);
    expect(state.fileMessage).toEqual({ key: 'file.saved', failed: false });
  });

  it('保存した後に文書を変えると、また「保存していない変更」になる', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(createFakeDeps(true).deps, false);

    useAppStore.getState().applyDocument(createEmptyPartDocument());

    const state = useAppStore.getState();
    expect(hasUnsavedChanges(state.document, state.savedDocument)).toBe(true);
    // 形が変わったら「保存しました」の知らせは消える。
    expect(state.fileMessage).toBeNull();
  });

  it('候補名はファイル名から作り、.pcad を必ず付ける', async () => {
    const fake = createFakeGateway();
    useFake(fake);

    await savePart(createFakeDeps(true).deps, false);

    expect(fake.saveCalls[0].suggestedName).toBe('名称未設定.pcad');
  });

  it('はじめの保存は場所を聞き、2 回目からは覚えた先へ黙って上書きする', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);
    expect(fake.saveCalls[0].saveAs).toBe(true);

    useAppStore.getState().applyDocument(createEmptyPartDocument());
    await savePart(createFakeDeps(true).deps, false);
    expect(fake.saveCalls[1].saveAs).toBe(false);
  });

  it('「名前を付けて保存」は覚えた先があっても必ず場所を聞く', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    await savePart(createFakeDeps(true).deps, false);

    await savePart(createFakeDeps(true).deps, true);

    expect(fake.saveCalls[1].saveAs).toBe(true);
  });

  it('サムネイルが作れなくても保存できる(サムネイルなしのファイルになる)', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true, null).deps, false);

    expect(thumbnailOf(fake.stored())).toBeUndefined();
  });

  it('サムネイルがあればファイルへ入る', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const thumbnail = new Uint8Array([137, 80, 78, 71]);

    await savePart(createFakeDeps(true, thumbnail).deps, false);

    expect(thumbnailOf(fake.stored())).toEqual(thumbnail);
  });

  it('保存を取り消すと、ファイル名も知らせも変わらない', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    const state = useAppStore.getState();
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    expect(state.fileMessage).toBeNull();
  });

  it('保存に成功したら自動保存の控えを消す(計画書 タスク24)', async () => {
    const fake = createFakeGateway();
    useFake(fake);
    const autoSave = createFakeAutoSaver();
    useAppStore.setState({ autoSaver: autoSave.saver });
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    expect(autoSave.discards()).toBe(1);
  });

  it('保存を取り消したときは控えを消さない', async () => {
    const fake = createFakeGateway({ saveCancels: true });
    useFake(fake);
    const autoSave = createFakeAutoSaver();
    useAppStore.setState({ autoSaver: autoSave.saver });
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    expect(autoSave.discards()).toBe(0);
  });

  it('保存が失敗したら理由を帯へ出し、保存済みの記録は作らない', async () => {
    const fake = createFakeGateway({ saveThrows: true });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await savePart(createFakeDeps(true).deps, false);

    const state = useAppStore.getState();
    expect(state.fileMessage).toEqual({ key: 'file.saveFailed', failed: true });
    expect(state.savedDocument).toBeNull();
  });
});

describe('開く(FR-806、NFR-RE-1)', () => {
  it('取り消したときは文書も知らせも変わらない', async () => {
    const fake = createFakeGateway({ openCancels: true });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toBe(before);
    expect(state.fileMessage).toBeNull();
  });

  it('壊れたバイト列では理由を帯へ出し、今の文書は変えない', async () => {
    const fake = createFakeGateway({ openBytes: new Uint8Array([0, 1, 2, 3]) });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toBe(before);
    expect(state.fileName).toBeNull();
    expect(state.fileMessage).toEqual({ key: 'file.error.corrupted', failed: true });
  });

  it('中身が入っていない ZIP は「中身が見つからない」と断る', async () => {
    const fake = createFakeGateway({ openBytes: zipWithoutDocument() });
    useFake(fake);

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.missingDocument',
      failed: true,
    });
  });

  it('新しい版のファイルは「アプリを更新してください」と断る', async () => {
    const fake = createFakeGateway({ openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION + 1) });
    useFake(fake);

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.tooNew',
      failed: true,
    });
  });

  it('古い版のファイルは「古い形式」と断る', async () => {
    const fake = createFakeGateway({ openBytes: pcadWithSchema(OLDEST_UNMIGRATABLE_SCHEMA_VERSION) });
    useFake(fake);

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({ key: 'file.error.tooOld', failed: true });
  });

  it('別のアプリのファイルは「部品ファイルではない」と断る', async () => {
    const other = `{"schema":${String(PCAD_SCHEMA_VERSION)},"kind":"part","app":"ほかのアプリ","savedAt":"2026-09-03T00:00:00.000Z","document":{}}`;
    useFake(createFakeGateway({ openBytes: pcadWithDocumentText(other) }));

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.wrongKind',
      failed: true,
    });
  });

  it('部品ではない種別(図面など)も「部品ファイルではない」と断る', async () => {
    const drawing = `{"schema":${String(PCAD_SCHEMA_VERSION)},"kind":"drawing","app":"PointerCAD","savedAt":"2026-09-03T00:00:00.000Z","document":{}}`;
    useFake(createFakeGateway({ openBytes: pcadWithDocumentText(drawing) }));

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.wrongKind',
      failed: true,
    });
  });

  it('欄の足りない部品は「壊れている」と断る', async () => {
    const broken = `{"schema":${String(PCAD_SCHEMA_VERSION)},"kind":"part","app":"PointerCAD","savedAt":"2026-09-03T00:00:00.000Z","document":{}}`;
    useFake(createFakeGateway({ openBytes: pcadWithDocumentText(broken) }));

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().fileMessage).toEqual({
      key: 'file.error.corrupted',
      failed: true,
    });
  });

  it('口そのものが失敗したら「開けませんでした」を出す', async () => {
    const fake = createFakeGateway({ openThrows: true });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);

    await openPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toBe(before);
    expect(state.fileMessage).toEqual({ key: 'file.openFailed', failed: true });
  });

  it('保存していない変更があれば確認し、断られたら開かない', async () => {
    const fake = createFakeGateway({ openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION) });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);
    const deps = createFakeDeps(false);

    await openPart(deps.deps);

    expect(deps.confirmed).toEqual(['file.discardConfirm']);
    expect(useAppStore.getState().document).toBe(before);
  });

  it('開いた後は Undo で開く前へ戻れる', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);
    await savePart(createFakeDeps(true).deps, false);
    useAppStore.getState().resetDocument(createEmptyPartDocument());

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().canUndo).toBe(true);
  });

  it('開くと documentVersion が進む(選んでいる欄の下書きを捨てる合図、9b)', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    await savePart(createFakeDeps(true).deps, false);
    const before = useAppStore.getState().documentVersion;

    await openPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });
});

describe('新規(FR-806、NFR-UX-3)', () => {
  it('保存していない変更があるときは確認し、断られたら何も変えない', async () => {
    useFake(createFakeGateway());
    const before = partWithPoint();
    useAppStore.getState().applyDocument(before);
    const deps = createFakeDeps(false);

    await newPart(deps.deps);

    expect(deps.confirmed).toEqual(['file.discardConfirm']);
    expect(useAppStore.getState().document).toBe(before);
  });

  it('了承すると空の部品になり、名前は消え、履歴も作り直される', async () => {
    const fake = createFakeGateway({ savedName: '部品1.pcad' });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(createFakeDeps(true).deps, false);
    useAppStore.getState().applyDocument(createEmptyPartDocument());
    expect(useAppStore.getState().canUndo).toBe(true);

    await newPart(createFakeDeps(true).deps);

    const state = useAppStore.getState();
    expect(state.document).toEqual(createEmptyPartDocument());
    expect(state.fileName).toBeNull();
    expect(state.savedDocument).toBeNull();
    expect(state.undoStack.past).toEqual([]);
    expect(state.undoStack.future).toEqual([]);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
  });

  it('何もしていないときは確認しない(まだ失うものが無い)', async () => {
    useFake(createFakeGateway());
    const deps = createFakeDeps(false);

    await newPart(deps.deps);

    expect(deps.confirmed).toEqual([]);
    expect(useAppStore.getState().document).toEqual(createEmptyPartDocument());
  });

  it('新規にすると documentVersion が進む(選んでいる欄の下書きを捨てる合図、9b)', async () => {
    useFake(createFakeGateway());
    const before = useAppStore.getState().documentVersion;

    await newPart(createFakeDeps(true).deps);

    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });
});

describe('最近使ったファイル(FR-807、P6 タスク28)', () => {
  it('開けたファイルの名前が履歴に入る', async () => {
    useFake(
      createFakeGateway({
        openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION),
        openName: '読んだ.pcad',
      }),
    );
    const storage = createMemoryStorage();

    await openPart(createFakeDeps(true, null, storage).deps);

    const list = loadRecentFiles(storage);
    expect(list.map((entry) => entry.name)).toEqual(['読んだ.pcad']);
    // 時刻も一緒に残る(名前と時刻の 2 欄だけ、§0.a-0.38)。
    expect(Number.isFinite(Date.parse(list[0].at))).toBe(true);
  });

  it('開けなかったファイルは履歴に入らない(勧め直さない)', async () => {
    useFake(
      createFakeGateway({
        openBytes: pcadWithDocumentText('壊れています'),
        openName: 'こわれた.pcad',
      }),
    );
    const storage = createMemoryStorage();

    await openPart(createFakeDeps(true, null, storage).deps);

    expect(loadRecentFiles(storage)).toEqual([]);
  });

  it('取り消したときも履歴に入らない', async () => {
    useFake(createFakeGateway({ openCancels: true }));
    const storage = createMemoryStorage();

    await openPart(createFakeDeps(true, null, storage).deps);

    expect(loadRecentFiles(storage)).toEqual([]);
  });

  it('保存した名前も履歴に入り、別名保存の後は新しい名前が先頭・元の名前も残る', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    const storage = createMemoryStorage();
    useAppStore.getState().applyDocument(partWithPoint());

    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true, null, storage).deps, false);
    fake.setNextName('部品2.pcad');
    await savePart(createFakeDeps(true, null, storage).deps, true);

    expect(loadRecentFiles(storage).map((entry) => entry.name)).toEqual([
      '部品2.pcad',
      '部品1.pcad',
    ]);
  });

  it('保存が取り消されたら履歴に入らない', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    const storage = createMemoryStorage();
    fake.setNextName(null);

    await savePart(createFakeDeps(true, null, storage).deps, false);

    expect(loadRecentFiles(storage)).toEqual([]);
  });
});

describe('別名保存(FR-812、P6 §0.a-0.37)', () => {
  it('元のファイルは変わらず、以後の保存先が新しい名前になる', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    useAppStore.getState().applyDocument(partWithPoint());
    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true).deps, false);
    // 後で比べるために写しを取る(記憶上の入れ物ごと差し替えられても気づけるように)。
    const original = new Uint8Array(fake.files().get('部品1.pcad') ?? []);
    expect(original.byteLength).toBeGreaterThan(0);

    // 中身を変えてから別名保存する。
    useAppStore.getState().applyDocument(createEmptyPartDocument());
    fake.setNextName('部品2.pcad');
    await savePart(createFakeDeps(true).deps, true);

    expect(useAppStore.getState().fileName).toBe('部品2.pcad');
    expect(fake.files().get('部品2.pcad')).toBeDefined();
    // 元のファイルは 1 バイトも変わっていない(FR-812「元のファイルを変更せずに」)。
    expect(fake.files().get('部品1.pcad')).toEqual(original);
  });

  it('別名保存の後の「保存」は、名前を訊かずに新しい名前へ書く', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true).deps, false);
    fake.setNextName('部品2.pcad');
    await savePart(createFakeDeps(true).deps, true);
    const askedBefore = fake.asked();

    useAppStore.getState().applyDocument(partWithPoint());
    await savePart(createFakeDeps(true).deps, false);

    expect(fake.asked()).toBe(askedBefore);
    expect([...fake.files().keys()]).toEqual(['部品1.pcad', '部品2.pcad']);
    expect(useAppStore.getState().fileName).toBe('部品2.pcad');
  });

  it('別名保存を取り消すと、保存先も名前も変わらない', async () => {
    const fake = createNamedGateway();
    useGateway(fake.gateway);
    fake.setNextName('部品1.pcad');
    await savePart(createFakeDeps(true).deps, false);

    fake.setNextName(null);
    await savePart(createFakeDeps(true).deps, true);

    expect(useAppStore.getState().fileName).toBe('部品1.pcad');
    expect([...fake.files().keys()]).toEqual(['部品1.pcad']);
  });

  it('ストアの入口(saveDocumentAs)は saveAs を立てて保存する(入口の配線はタスク33)', async () => {
    const fake = createFakeGateway({ savedName: '別名.pcad' });
    useFake(fake);
    useAppStore.getState().applyDocument(partWithPoint());

    await useAppStore.getState().saveDocumentAs();

    expect(fake.saveCalls.map((call) => call.saveAs)).toEqual([true]);
    expect(useAppStore.getState().fileName).toBe('別名.pcad');
  });
});

/*
 * 添付(読み込んだ形・下絵)の受け渡し(P6 タスク32、タスク21 の申し送り)。
 *
 * 読み込んだ形の B-rep は再計算で作り直せない(§0.a-0.9 の例外)ので、保存のたびに
 * 一緒に書き、開いたときに受け取って持ち回らないと**開き直せない部品**ができる。
 */

/** 検査用の三角形 1 枚ぶんの網。 */
function oneTriangleMesh(): ImportedMeshBytes {
  return {
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
  };
}

/** 読み込んだ形 1 つと読み込んだ三角形 1 つを履歴に持つ部品文書。 */
function importedDocument(): PartDocument {
  return {
    ...createEmptyPartDocument(),
    solids: [
      {
        id: 'importedSolid-1',
        kind: 'importedSolid',
        name: '読み込んだ形1',
        suppressed: false,
        shapeRef: 'importedSolid-1',
        source: { format: 'step', fileName: 'bracket.step', unit: 'mm', byteLength: 100 },
        bodyKind: 'solid',
      },
      {
        id: 'importedMesh-1',
        kind: 'importedMesh',
        name: '読み込んだ三角形の形1',
        suppressed: false,
        meshRef: 'importedMesh-1',
        source: { format: 'stl', fileName: 'cover.stl', unit: 'mm', byteLength: 684 },
        triangleCount: 1,
      },
    ],
  };
}

function importedAttachments(): PcadAttachments {
  return {
    shapes: new Map([['importedSolid-1', Uint8Array.from([1, 2, 3])]]),
    meshes: new Map([['importedMesh-1', oneTriangleMesh()]]),
    canvases: new Map(),
  };
}

describe('保存と読み込みの添付(P6 §0.a-0.9・0.24)', () => {
  it('添付を渡さないと、読み込んだ形を含む部品は開き直せない(申し送りの再現)', async () => {
    const fake = createFakeGateway();
    const fakeDeps = createFakeDeps(true);
    useAppStore.setState({ fileGateway: fake.gateway });
    useAppStore.getState().resetDocument(importedDocument());

    await savePart(fakeDeps.deps, false);
    const stored = fake.stored();
    if (stored === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(stored.bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('missingField');
    }
  });

  it('attachmentsOf を渡すと、読み込んだ形を含む部品が開き直せる', async () => {
    const fake = createFakeGateway();
    const fakeDeps = createFakeDeps(true);
    const deps: PartFileDeps = { ...fakeDeps.deps, attachmentsOf: () => importedAttachments() };
    useAppStore.setState({ fileGateway: fake.gateway });
    const document = importedDocument();
    useAppStore.getState().resetDocument(document);

    await savePart(deps, false);
    const stored = fake.stored();
    if (stored === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(stored.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
      expect(parsed.attachments.shapes.get('importedSolid-1')).toEqual(Uint8Array.from([1, 2, 3]));
      expect(parsed.attachments.meshes.get('importedMesh-1')?.indices)
        .toEqual(Uint32Array.from([0, 1, 2]));
    }
  });

  it('サムネイルと添付は両方入る(片方が片方を落とさない)', async () => {
    const fake = createFakeGateway();
    const thumbnail = Uint8Array.from([137, 80, 78, 71]);
    const fakeDeps = createFakeDeps(true, thumbnail);
    const deps: PartFileDeps = { ...fakeDeps.deps, attachmentsOf: () => importedAttachments() };
    useAppStore.setState({ fileGateway: fake.gateway });
    useAppStore.getState().resetDocument(importedDocument());

    await savePart(deps, false);
    const stored = fake.stored();
    if (stored === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(stored.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.thumbnailPng).toEqual(thumbnail);
      expect(parsed.attachments.shapes.size).toBe(1);
    }
  });

  it('開くと、ファイルに入っていた添付を受け取れる', async () => {
    const document = importedDocument();
    const bytes = writePcadFile(document, { attachments: importedAttachments() });
    const fake = createFakeGateway({ openBytes: bytes, openName: '読み込んだ部品.pcad' });
    const fakeDeps = createFakeDeps(true);
    const received: PcadAttachments[] = [];
    const deps: PartFileDeps = {
      ...fakeDeps.deps,
      onAttachmentsLoaded: (attachments) => {
        received.push(attachments);
      },
    };
    useAppStore.setState({ fileGateway: fake.gateway });

    await openPart(deps);

    expect(useAppStore.getState().document).toEqual(document);
    expect(received).toHaveLength(1);
    expect(received[0].shapes.get('importedSolid-1')).toEqual(Uint8Array.from([1, 2, 3]));
    expect(received[0].meshes.size).toBe(1);
  });

  it('開けなかったときは添付を渡さない(今の文書も変えない)', async () => {
    const fake = createFakeGateway({ openBytes: Uint8Array.from([1, 2, 3]) });
    const fakeDeps = createFakeDeps(true);
    const received: PcadAttachments[] = [];
    const deps: PartFileDeps = {
      ...fakeDeps.deps,
      onAttachmentsLoaded: (attachments) => {
        received.push(attachments);
      },
    };
    useAppStore.setState({ fileGateway: fake.gateway });
    const before = useAppStore.getState().document;

    await openPart(deps);

    expect(received).toHaveLength(0);
    expect(useAppStore.getState().document).toBe(before);
  });

  it('添付を 1 つも持たないファイルを開いても、空の表が渡る(版 6 までのファイル)', async () => {
    const bytes = writePcadFile(createEmptyPartDocument(), {});
    const fake = createFakeGateway({ openBytes: bytes, openName: '古い部品.pcad' });
    const fakeDeps = createFakeDeps(true);
    const received: PcadAttachments[] = [];
    const deps: PartFileDeps = {
      ...fakeDeps.deps,
      onAttachmentsLoaded: (attachments) => {
        received.push(attachments);
      },
    };
    useAppStore.setState({ fileGateway: fake.gateway });

    await openPart(deps);

    expect(received).toHaveLength(1);
    expect(received[0].shapes.size).toBe(0);
    expect(received[0].meshes.size).toBe(0);
    expect(received[0].canvases.size).toBe(0);
  });
});
