import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  AUTO_SAVE_INTERVAL_MS,
  createAutoSaver,
  createIndexedDbAutoSaveStorage,
  createMemoryAutoSaveStorage,
  type AutoSaveRecord,
  type AutoSaveStorage,
  type AutoSaveTimerHandle,
} from './autoSave.js';
import { readPcadFile, type ImportedMeshBytes, type PcadAttachments } from './pcad/pcadFile.js';

/** 検査で保存時刻を固定する。 */
const SAVED_AT = '2026-09-03T01:23:45.678Z';

function withName(document: PartDocument, name: string): PartDocument {
  return { ...document, name };
}

/**
 * setTimeout / clearTimeout の代わりに注入する、手で進められる偽のタイマー。
 * `pending` に予約中の呼び出しを1つだけ持つ(自動保存は常に「次の1回」だけを予約するため)。
 */
function createManualTimer(): {
  readonly schedule: (handler: () => void, ms: number) => AutoSaveTimerHandle;
  readonly cancel: (handle: AutoSaveTimerHandle) => void;
  readonly scheduledMs: number[];
  readonly fire: () => void;
  readonly pendingCount: () => number;
} {
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const scheduledMs: number[] = [];
  return {
    schedule: (handler, ms) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, handler);
      scheduledMs.push(ms);
      return id;
    },
    cancel: (handle) => {
      if (typeof handle === 'number') {
        pending.delete(handle);
      }
    },
    scheduledMs,
    fire: () => {
      const [firstEntry] = pending;
      if (firstEntry === undefined) {
        return;
      }
      const [id, handler] = firstEntry;
      pending.delete(id);
      handler();
    },
    pendingCount: () => pending.size,
  };
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('AUTO_SAVE_INTERVAL_MS', () => {
  it('既定は5分(FR-805)', () => {
    expect(AUTO_SAVE_INTERVAL_MS).toBe(300_000);
  });
});

describe('createMemoryAutoSaveStorage', () => {
  it('read の初回は null', async () => {
    const storage = createMemoryAutoSaveStorage();
    expect(await storage.read()).toBeNull();
  });

  it('write の後、read で同じレコードが読める', async () => {
    const storage = createMemoryAutoSaveStorage();
    const record: AutoSaveRecord = {
      savedAt: SAVED_AT,
      bytes: new Uint8Array([1, 2, 3]),
      documentName: '部品1',
    };
    await storage.write(record);
    expect(await storage.read()).toEqual(record);
  });

  it('write の後に clear すると read は null に戻る', async () => {
    const storage = createMemoryAutoSaveStorage();
    await storage.write({ savedAt: SAVED_AT, bytes: new Uint8Array(), documentName: '部品1' });
    await storage.clear();
    expect(await storage.read()).toBeNull();
  });

  it('write を2回行うと、後の1件だけが残る', async () => {
    const storage = createMemoryAutoSaveStorage();
    await storage.write({ savedAt: SAVED_AT, bytes: new Uint8Array([1]), documentName: '1回目' });
    const second: AutoSaveRecord = {
      savedAt: '2026-09-03T02:00:00.000Z',
      bytes: new Uint8Array([2]),
      documentName: '2回目',
    };
    await storage.write(second);
    expect(await storage.read()).toEqual(second);
  });
});

describe('createIndexedDbAutoSaveStorage(indexedDB が無い環境)', () => {
  // Node の Vitest 環境には indexedDB が無いので、この分岐が自然に検査できる
  // (docs/報告記録.md 2026-09-02 14:50 の④と同じ理由で、実際の読み書きは E2E へ送る)。

  it('read は null を返す', async () => {
    const storage = createIndexedDbAutoSaveStorage();
    expect(await storage.read()).toBeNull();
  });

  it('write は例外を投げず、何もしないまま解決する', async () => {
    const storage = createIndexedDbAutoSaveStorage();
    await expect(
      storage.write({ savedAt: SAVED_AT, bytes: new Uint8Array([1]), documentName: '部品1' }),
    ).resolves.toBeUndefined();
    // 実際には書けていない(保管庫が無いため)。
    expect(await storage.read()).toBeNull();
  });

  it('clear は例外を投げず、何もしないまま解決する', async () => {
    const storage = createIndexedDbAutoSaveStorage();
    await expect(storage.clear()).resolves.toBeUndefined();
  });

  it('db 名・ストア名を渡しても(使われないだけで)同じ挙動', async () => {
    const storage = createIndexedDbAutoSaveStorage('別名', '別ストア');
    expect(await storage.read()).toBeNull();
  });
});

describe('createAutoSaver', () => {
  it('一度も markDirty しなければ、間隔が来ても書かない', () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    timer.fire();
    saver.stop();
    return storage.read().then((record) => {
      expect(record).toBeNull();
    });
  });

  it('変更後、間隔が経過すると1回書く', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 12_345,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '部品A');
    saver.markDirty(document);
    timer.fire();
    // 書き込みは Promise チェーンを1段挟むので、マイクロタスクを1つ待つ。
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();

    const record = await storage.read();
    expect(record).not.toBeNull();
    if (record === null) {
      throw new Error('unreachable');
    }
    expect(record.documentName).toBe('部品A');
    expect(record.savedAt).toBe(new Date(12_345).toISOString());
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
    }
  });

  it('intervalMs を渡すと、その値でタイマーを予約する', () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 42_000,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    saver.stop();
    expect(timer.scheduledMs[0]).toBe(42_000);
  });

  it('間隔内の連続した変更は、最新の内容で1回だけ書く', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const first = withName(createEmptyPartDocument(), '途中の内容');
    const second = withName(createEmptyPartDocument(), '最新の内容');
    saver.markDirty(first);
    saver.markDirty(second);
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();

    const record = await storage.read();
    expect(record?.documentName).toBe('最新の内容');
  });

  it('変更が無い間隔では書かない(前回と同じ内容を積み増ししない)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '部品A');
    saver.markDirty(document);
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    const afterFirstWrite = await storage.read();

    // 2度目の間隔: markDirty を呼んでいないので変更なし。
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();
    const afterSecondTick = await storage.read();

    expect(afterSecondTick).toEqual(afterFirstWrite);
  });

  it('saveNow は間隔を待たずすぐ書く', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 999,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '即時保存');
    await saver.saveNow(document);
    saver.stop();

    const record = await storage.read();
    expect(record?.documentName).toBe('即時保存');
  });

  it('readLatest は保管庫の内容をそのまま返し、readPcadFile で元の文書に戻る(往復)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '復元候補');
    await saver.saveNow(document);
    saver.stop();

    const latest = await saver.readLatest();
    expect(latest).not.toBeNull();
    if (latest === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(latest.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
    }
  });

  it('discard の後は readLatest が null になる', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    await saver.saveNow(withName(createEmptyPartDocument(), '破棄予定'));
    await saver.discard();
    saver.stop();

    expect(await saver.readLatest()).toBeNull();
  });

  it('stop の後は、間隔が来ても書かない', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    saver.markDirty(withName(createEmptyPartDocument(), '止めた後'));
    saver.stop();
    // stop は予約済みのタイマーも取り消すので、fire しても何も起きない。
    expect(timer.pendingCount()).toBe(0);
    timer.fire();
    await Promise.resolve();

    expect(await storage.read()).toBeNull();
  });

  it('書き込み中に saveNow を重ねても、書き込みは1回だけ(重複防止)', async () => {
    const writeCalls: AutoSaveRecord[] = [];
    const deferred = createDeferred();
    const storage: AutoSaveStorage = {
      read: () => Promise.resolve(null),
      write: (record) => {
        writeCalls.push(record);
        return deferred.promise;
      },
      clear: () => Promise.resolve(),
    };
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    const document = withName(createEmptyPartDocument(), '重複防止');

    const first = saver.saveNow(document);
    const second = saver.saveNow(document);
    deferred.resolve();
    await Promise.all([first, second]);
    saver.stop();

    expect(writeCalls.length).toBe(1);
  });

  it('書き込みが失敗しても例外にならず、onError へ渡る', async () => {
    const failure = new Error('保存できませんでした');
    const errors: unknown[] = [];
    const storage: AutoSaveStorage = {
      read: () => Promise.resolve(null),
      write: () => Promise.reject(failure),
      clear: () => Promise.resolve(),
    };
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      onError: (error) => {
        errors.push(error);
      },
    });

    await expect(saver.saveNow(createEmptyPartDocument())).resolves.toBeUndefined();
    saver.stop();

    expect(errors).toEqual([failure]);
  });
});

/*
 * 添付つきの控え(P6 タスク32、タスク21 の申し送り)。
 *
 * 読み込んだ形(`importedSolid` / `importedMesh`)を含む文書は、`shapes/*.brep` /
 * `meshes/*.bin` が一緒に入っていないと `readPcadFile` が `missingField` で断る。
 * 添付を渡さずに控えを取ると「開けない控え」になるので、渡す口があることと、
 * 渡したときに復元できることを両方固定する。
 */

/** 検査用の B-rep のバイト列(中身は解釈されないので、見分けの付く並びにする)。 */
function fakeBrepBytes(seed: number): Uint8Array {
  return Uint8Array.from([seed, seed + 1, seed + 2, seed + 3]);
}

/** 三角形 1 枚ぶんの網(頂点 3・三角形 1)。 */
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
        shapeRef: 'shape-1',
        source: { format: 'step', fileName: 'bracket.step', unit: 'mm', byteLength: 4494 },
        bodyKind: 'solid',
      },
      {
        id: 'importedMesh-1',
        kind: 'importedMesh',
        name: '読み込んだ三角形の形1',
        suppressed: false,
        meshRef: 'mesh-1',
        source: { format: 'stl', fileName: 'cover.stl', unit: 'mm', byteLength: 684 },
        triangleCount: 1,
      },
    ],
  };
}

/** 上の文書がそろえておくべき添付。 */
function importedAttachments(): PcadAttachments {
  return {
    shapes: new Map([['shape-1', fakeBrepBytes(7)]]),
    meshes: new Map([['mesh-1', oneTriangleMesh()]]),
    canvases: new Map(),
  };
}

describe('createAutoSaver の添付(P6 §0.a-0.9・0.24)', () => {
  it('添付を渡さないと、読み込んだ形を含む文書の控えは復元できない(申し送りの再現)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
    });
    await saver.saveNow(importedDocument());
    saver.stop();

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('missingField');
    }
  });

  it('attachmentsOf を渡すと、読み込んだ形を含む文書の控えが復元できる', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const document = importedDocument();
    const seen: PartDocument[] = [];
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      attachmentsOf: (target) => {
        seen.push(target);
        return importedAttachments();
      },
    });
    await saver.saveNow(document);
    saver.stop();

    // 書く直前に、いま書く文書そのものを渡して呼ばれる。
    expect(seen).toEqual([document]);

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.document).toEqual(document);
      expect(parsed.attachments.shapes.get('shape-1')).toEqual(fakeBrepBytes(7));
      expect(parsed.attachments.meshes.get('mesh-1')?.indices).toEqual(Uint32Array.from([0, 1, 2]));
    }
  });

  it('attachmentsOf が undefined を返したときは、添付なしで書く(版 6 までと同じ)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      attachmentsOf: () => undefined,
    });
    await saver.saveNow(createEmptyPartDocument());
    saver.stop();

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    const parsed = readPcadFile(record.bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.attachments.shapes.size).toBe(0);
      expect(parsed.attachments.meshes.size).toBe(0);
      expect(parsed.attachments.canvases.size).toBe(0);
    }
  });

  it('間隔ごとの書き込みでも添付を渡す(saveNow だけの配線にしない)', async () => {
    const storage = createMemoryAutoSaveStorage();
    const timer = createManualTimer();
    const saver = createAutoSaver({
      storage,
      intervalMs: 1000,
      now: () => 0,
      setTimeout: timer.schedule,
      clearTimeout: timer.cancel,
      attachmentsOf: () => importedAttachments(),
    });
    saver.markDirty(importedDocument());
    timer.fire();
    await Promise.resolve();
    await Promise.resolve();
    saver.stop();

    const record = await storage.read();
    if (record === null) {
      throw new Error('unreachable');
    }
    expect(readPcadFile(record.bytes).ok).toBe(true);
  });
});
