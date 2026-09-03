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
  readPcadFile,
  writePcadFile,
  type AutoSaver,
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

function createFakeDeps(answer: boolean, thumbnail: Uint8Array | null = null): FakeDeps {
  const confirmed: string[] = [];
  return {
    confirmed,
    deps: {
      captureThumbnail: () => thumbnail,
      confirmDiscard: (messageKey) => {
        confirmed.push(messageKey);
        return Promise.resolve(answer);
      },
    },
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

function useFake(fake: FakeGateway): void {
  useAppStore.setState({ fileGateway: fake.gateway });
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
    const fake = createFakeGateway({ openBytes: pcadWithSchema(PCAD_SCHEMA_VERSION - 1) });
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
});
