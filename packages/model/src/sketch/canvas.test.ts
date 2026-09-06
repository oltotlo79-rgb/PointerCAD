import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { affectsShape } from '../part/documentChange.js';
import type { SketchCanvas } from '../part/types.js';

import {
  CANVAS_INVALID_LENGTH_MESSAGE,
  CANVAS_SAME_POINT_MESSAGE,
  CANVAS_TOO_LARGE_MESSAGE,
  CANVAS_UNSUPPORTED_FORMAT_MESSAGE,
  canvasSizeFromScale,
  checkCanvasImage,
  detectImageFormat,
  MAX_CANVAS_IMAGE_BYTES,
  nextCanvasId,
  removeCanvas,
  scaleFromTwoPoints,
  setCanvasVisible,
  type CanvasPixelPoint,
} from './canvas.js';

/** 先頭に署名を置いた、それらしいバイト列(画像として正しい必要はない)。 */
function withSignature(signature: readonly number[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(signature, 0);
  return bytes;
}

function png(length = 64): Uint8Array {
  return withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], length);
}

function jpeg(length = 64): Uint8Array {
  return withSignature([0xff, 0xd8, 0xff, 0xe0], length);
}

/** GIF87a の署名。受け付けない形式の見本(§2.14 の表)。 */
function gif(length = 64): Uint8Array {
  return withSignature([0x47, 0x49, 0x46, 0x38, 0x37, 0x61], length);
}

/** 縮尺を出して、断られないことを確かめる。 */
function expectScale(p1: CanvasPixelPoint, p2: CanvasPixelPoint, lengthMm: number): number {
  const result = scaleFromTwoPoints(p1, p2, lengthMm);
  if (!result.ok) {
    throw new Error(`縮尺を出せるはず: ${result.reason}`);
  }
  return result.scale;
}

function canvas(id: string, visible = true): SketchCanvas {
  return {
    id,
    name: id,
    plane: 'xy',
    imageId: id,
    width: expressionValueFromNumber(400),
    height: expressionValueFromNumber(300),
    origin: {
      mode: 'absolute',
      x: expressionValueFromNumber(0),
      y: expressionValueFromNumber(0),
      z: expressionValueFromNumber(0),
    },
    rotation: expressionValueFromNumber(0),
    opacity: expressionValueFromNumber(0.5),
    visible,
  };
}

describe('下絵の画像の受け入れ(FR-332、P6 §0.a-0.45、§2.8 の断りの表、タスク38)', () => {
  it('PNG の署名(89 50 4E 47 0D 0A 1A 0A)を受ける', () => {
    expect(detectImageFormat(png())).toBe('png');
    const checked = checkCanvasImage(png());
    expect(checked).toEqual({ ok: true, format: 'png' });
  });

  it('JPEG の署名(FF D8 FF)を受ける', () => {
    expect(detectImageFormat(jpeg())).toBe('jpeg');
    expect(checkCanvasImage(jpeg()).ok).toBe(true);
  });

  it('GIF は「対応していない画像です。」で断る(§0.a-0.45)', () => {
    expect(detectImageFormat(gif())).toBeNull();
    const checked = checkCanvasImage(gif());
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('断るはず');
    }
    expect(checked.reason).toBe('unsupportedFormat');
    expect(checked.message).toBe('対応していない画像です。');
    expect(CANVAS_UNSUPPORTED_FORMAT_MESSAGE).toBe('対応していない画像です。');
  });

  it('空のバイト列・署名の途中で切れたバイト列も同じ断りになる', () => {
    expect(detectImageFormat(new Uint8Array(0))).toBeNull();
    expect(detectImageFormat(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(detectImageFormat(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('上限は 8MB(8388608 バイト)で、ちょうどの大きさは受ける', () => {
    expect(MAX_CANVAS_IMAGE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CANVAS_IMAGE_BYTES).toBe(8_388_608);
    expect(checkCanvasImage(png(MAX_CANVAS_IMAGE_BYTES)).ok).toBe(true);
  });

  it('8MB を 1 バイト超えると「画像が大きすぎます。8MB までにしてください。」で断る', () => {
    const checked = checkCanvasImage(png(MAX_CANVAS_IMAGE_BYTES + 1));
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('断るはず');
    }
    expect(checked.reason).toBe('tooLarge');
    expect(checked.message).toBe('画像が大きすぎます。8MB までにしてください。');
    expect(CANVAS_TOO_LARGE_MESSAGE).toBe('画像が大きすぎます。8MB までにしてください。');
  });

  it('大きすぎる GIF は形式のほうを先に断る(直し方が分かるように)', () => {
    const checked = checkCanvasImage(gif(MAX_CANVAS_IMAGE_BYTES + 1));
    expect(checked.ok).toBe(false);
    if (checked.ok) {
      throw new Error('断るはず');
    }
    expect(checked.reason).toBe('unsupportedFormat');
  });
});

describe('下絵の 2 点の寸法合わせ(FR-332、P6 §0.a-0.46、§2.14、タスク38)', () => {
  it('(100,100)〜(500,100) を 200mm とすると d = 400・s = 0.5(§2.14 の表)', () => {
    const result = scaleFromTwoPoints([100, 100], [500, 100], 200);
    if (!result.ok) {
      throw new Error('縮尺を出せるはず');
    }
    expect(result.pixelDistance).toBe(400);
    expect(result.scale).toBe(0.5);
  });

  it('同じ縮尺で 800×600 画素の画像は 400mm × 300mm になる(§2.14 の表)', () => {
    const scale = expectScale([100, 100], [500, 100], 200);
    expect(canvasSizeFromScale(scale, 800, 600)).toEqual({ widthMm: 400, heightMm: 300 });
  });

  it('(0,0)〜(300,400) を 100mm とすると d = 500・s = 0.2(3-4-5 の直角三角形)', () => {
    const result = scaleFromTwoPoints([0, 0], [300, 400], 100);
    if (!result.ok) {
      throw new Error('縮尺を出せるはず');
    }
    expect(result.pixelDistance).toBe(500);
    expect(result.scale).toBe(0.2);
  });

  it('2 点の順を入れ替えても縮尺は同じ(距離は符号を持たない)', () => {
    expect(expectScale([500, 100], [100, 100], 200)).toBe(0.5);
  });

  it('2 点が同じ位置なら断る(0 除算の防止、NFR-UX-5)', () => {
    const result = scaleFromTwoPoints([100, 100], [100, 100], 200);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('断るはず');
    }
    expect(result.reason).toBe('samePoint');
    expect(result.message).toBe('2 つの点が同じ位置です。離れた 2 点を指してください。');
    expect(CANVAS_SAME_POINT_MESSAGE).toBe(result.message);
  });

  it('実寸が 0・負・NaN なら断る(縮尺が 0 や負や NaN の下絵を作らない)', () => {
    for (const lengthMm of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = scaleFromTwoPoints([0, 0], [300, 400], lengthMm);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('断るはず');
      }
      expect(result.reason).toBe('invalidLength');
      expect(result.message).toBe(CANVAS_INVALID_LENGTH_MESSAGE);
    }
  });
});

describe('下絵の一覧の編集と再計算(FR-332、§2.14、タスク38)', () => {
  it('id は canvas-<n> の連番で、1 つ消しても残りの最大の次を採る', () => {
    expect(nextCanvasId([])).toBe('canvas-1');
    const two = [canvas('canvas-1'), canvas('canvas-2')];
    expect(nextCanvasId(two)).toBe('canvas-3');
    expect(nextCanvasId(removeCanvas(two, 'canvas-1'))).toBe('canvas-3');
  });

  it('下絵を消せる。知らない id なら元の配列を同一参照のまま返す', () => {
    const list = [canvas('canvas-1'), canvas('canvas-2')];
    expect(removeCanvas(list, 'canvas-1')).toHaveLength(1);
    expect(removeCanvas(list, 'canvas-9')).toBe(list);
  });

  it('入切を切り替えられる。同じ値なら元の配列を同一参照のまま返す', () => {
    const list = [canvas('canvas-1')];
    const hidden = setCanvasVisible(list, 'canvas-1', false);
    expect(hidden[0].visible).toBe(false);
    expect(setCanvasVisible(hidden, 'canvas-1', false)).toBe(hidden);
  });

  it('起動時の部品は下絵を 1 枚も持たない', () => {
    expect(createEmptyPartDocument().canvases).toEqual([]);
  });

  it('下絵を足しても、入切を切り替えても形に影響しない(affectsShape が偽。§2.14)', () => {
    const document = createEmptyPartDocument();
    const added = { ...document, canvases: [canvas('canvas-1')] };
    expect(affectsShape(document, added)).toBe(false);
    const hidden = { ...added, canvases: setCanvasVisible(added.canvases, 'canvas-1', false) };
    expect(affectsShape(added, hidden)).toBe(false);
    expect(affectsShape(hidden, { ...hidden, canvases: removeCanvas(hidden.canvases, 'canvas-1') })).toBe(
      false,
    );
  });
});
