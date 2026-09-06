/**
 * 下絵の画像の口(計画書 docs/plans/P6-入出力.md §0.a-0.45、タスク39)。対応要件: FR-332。
 *
 * DOM も画像の復号器も無い Node で走らせるため、`document` と `createImageBitmap` は
 * **偽の相手を引数で渡して**確かめる(`fileGateway.test.ts` と同じ流儀。本物の `globalThis` へ
 * 欄を差し込むと他の検査へ漏れる)。
 */

import { describe, expect, it } from 'vitest';

import {
  CANVAS_IMAGE_ACCEPT,
  DEFAULT_CANVAS_OPACITY,
  DEFAULT_CANVAS_WIDTH_MM,
  canvasImageMimeType,
  decodeCanvasImage,
  newSketchCanvas,
  pickCanvasImage,
} from './canvasFile.js';

/** `Uint8Array` を `ArrayBuffer` へ(偽のファイルが返す中身)。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** 偽の `<input type="file">` と、それを作る偽の `document`。 */
function createFakePickScope(file: unknown): {
  readonly scope: object;
  readonly log: string[];
  readonly input: { type: string; accept: string; hidden: boolean };
  fire(type: string): void;
} {
  const log: string[] = [];
  const listeners = new Map<string, () => void>();
  const input = {
    type: '',
    accept: '',
    hidden: false,
    files: { 0: file },
    addEventListener(type: string, listener: () => void): void {
      listeners.set(type, listener);
    },
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
        return input;
      },
      body: {
        append(): void {
          log.push('append');
        },
      },
    },
  };
  return {
    scope,
    log,
    input,
    fire(type): void {
      listeners.get(type)?.();
    },
  };
}

describe('下絵に使える画像の種類(§0.a-0.45)', () => {
  it('選ぶ窓に出すのは PNG と JPEG だけ', () => {
    expect(CANVAS_IMAGE_ACCEPT).toBe('image/png,image/jpeg');
  });

  it('形式ごとの MIME 型を返す', () => {
    expect(canvasImageMimeType('png')).toBe('image/png');
    expect(canvasImageMimeType('jpeg')).toBe('image/jpeg');
  });
});

describe('画像を選ぶ(FR-332)', () => {
  it('選んだファイルの名前とバイト列を返し、入れた口を必ず片付ける', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fake = createFakePickScope({
      name: '間取り.png',
      arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(toArrayBuffer(bytes)),
    });

    const picked = pickCanvasImage(fake.scope);
    fake.fire('change');
    expect(await picked).toEqual({ fileName: '間取り.png', bytes });
    // PNG と JPEG だけを選べる窓を出し、押した後の `<input>` を残さない。
    expect(fake.input.accept).toBe(CANVAS_IMAGE_ACCEPT);
    expect(fake.input.type).toBe('file');
    expect(fake.log).toEqual(['createElement:input', 'append', 'click', 'remove']);
  });

  it('取り消したら null(例外にしない)', async () => {
    const fake = createFakePickScope(null);
    const picked = pickCanvasImage(fake.scope);
    fake.fire('cancel');
    expect(await picked).toBeNull();
    expect(fake.log).toContain('remove');
  });

  it('ファイルが選ばれていなければ null', async () => {
    const fake = createFakePickScope(undefined);
    const picked = pickCanvasImage(fake.scope);
    fake.fire('change');
    expect(await picked).toBeNull();
  });

  it('ファイルを選ぶ窓を出せない相手(ブラウザではない)なら断る', async () => {
    await expect(pickCanvasImage({})).rejects.toThrow();
  });
});

describe('画像を描ける形へ復号する(§0.a-0.46)', () => {
  /** 偽の復号器。頼まれた向きと MIME 型を控える。 */
  function createFakeDecoderScope(result: unknown): {
    readonly scope: object;
    readonly calls: { type: string; orientation: string | undefined }[];
  } {
    const calls: { type: string; orientation: string | undefined }[] = [];
    const scope = {
      createImageBitmap(blob: Blob, options?: { readonly imageOrientation?: 'flipY' }): Promise<unknown> {
        calls.push({ type: blob.type, orientation: options?.imageOrientation });
        return Promise.resolve(result);
      },
    };
    return { scope, calls };
  }

  it('画素の幅・高さを返し、上下を返して復号するよう頼む(three の flipY は ImageBitmap に効かない)', async () => {
    const fake = createFakeDecoderScope({ width: 800, height: 600 });
    const image = await decodeCanvasImage(new Uint8Array([0xff, 0xd8, 0xff]), 'jpeg', fake.scope);
    expect(image.width).toBe(800);
    expect(image.height).toBe(600);
    expect(fake.calls).toEqual([{ type: 'image/jpeg', orientation: 'flipY' }]);
  });

  it('形式に合う MIME 型を渡す(PNG)', async () => {
    const fake = createFakeDecoderScope({ width: 2, height: 3 });
    await decodeCanvasImage(new Uint8Array([0x89, 0x50]), 'png', fake.scope);
    expect(fake.calls[0].type).toBe('image/png');
  });

  it('復号器を持たない相手なら断る', async () => {
    await expect(decodeCanvasImage(new Uint8Array([0x89]), 'png', {})).rejects.toThrow();
  });

  it('画素の大きさを持たないものが返ってきたら断る(壊れた画像)', async () => {
    const fake = createFakeDecoderScope({ width: 'とても大きい' });
    await expect(decodeCanvasImage(new Uint8Array([0x89]), 'png', fake.scope)).rejects.toThrow();
  });
});

describe('読み込んだ画像を下絵 1 枚にする(§0.a-0.45)', () => {
  it('幅 100mm と画像の縦横比で置き、名前はファイル名、id と画像の鍵は同じ', () => {
    const canvas = newSketchCanvas([], 'xy', '間取り.png', { width: 800, height: 600 });
    expect(canvas.id).toBe('canvas-1');
    // ZIP のエントリ `canvases/<imageId>.png` と 1 対 1 にする。
    expect(canvas.imageId).toBe('canvas-1');
    expect(canvas.name).toBe('間取り.png');
    expect(canvas.plane).toBe('xy');
    expect(canvas.width.value).toBe(DEFAULT_CANVAS_WIDTH_MM);
    // 800×600 の縦横比 0.75 → 高さ 75mm。
    expect(canvas.height.value).toBeCloseTo(75, 9);
    expect(canvas.opacity.value).toBe(DEFAULT_CANVAS_OPACITY);
    expect(canvas.rotation.value).toBe(0);
    expect(canvas.visible).toBe(true);
  });

  it('id は既存の下絵から続けて採番する', () => {
    const first = newSketchCanvas([], 'xy', 'a.png', { width: 10, height: 10 });
    const second = newSketchCanvas([first], 'xz', 'b.png', { width: 10, height: 10 });
    expect(second.id).toBe('canvas-2');
    expect(second.plane).toBe('xz');
  });

  it('画素の幅が 0(壊れた画像)でも高さを 0 にしない(掴めなくなるため)', () => {
    const canvas = newSketchCanvas([], 'xy', 'こわれ.png', { width: 0, height: 0 });
    expect(canvas.height.value).toBe(DEFAULT_CANVAS_WIDTH_MM);
  });
});
