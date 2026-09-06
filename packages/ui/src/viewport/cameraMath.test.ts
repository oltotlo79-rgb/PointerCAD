import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  cameraPosition,
  clamp,
  HOME_ORBIT,
  HOME_VISIBLE_FACE_NORMALS,
  labelWorldHeight,
  MAX_DISTANCE,
  MAX_ELEVATION,
  MIN_DISTANCE,
  orbit,
  ORBIT_RADIANS_PER_PIXEL,
  orthographicFrustumHeight,
  pan,
  viewDirection,
  worldUnitsPerPixel,
  zoom,
} from './cameraMath.js';

describe('視点の回転(FR-101)', () => {
  it('横に 100 ピクセル動かすと方位角が 0.8 ラジアン減る', () => {
    const rotated = orbit(HOME_ORBIT, 100, 0);
    expect(rotated.azimuth).toBeCloseTo(HOME_ORBIT.azimuth - 100 * ORBIT_RADIANS_PER_PIXEL, 12);
    // ホーム視点の方位角は −45°(2026-09-06 に +45° から変えた。`HOME_ORBIT` の注釈)。
    expect(rotated.azimuth).toBeCloseTo(-Math.PI / 4 - 0.8, 12);
  });

  it('縦に動かしても仰角は真上・真下を越えない', () => {
    expect(orbit(HOME_ORBIT, 0, 100_000).elevation).toBeCloseTo(MAX_ELEVATION, 12);
    expect(orbit(HOME_ORBIT, 0, -100_000).elevation).toBeCloseTo(-MAX_ELEVATION, 12);
  });

  it('回転しても距離と注視点は変わらない', () => {
    const rotated = orbit(HOME_ORBIT, 37, -21);
    expect(rotated.distance).toBe(HOME_ORBIT.distance);
    expect(rotated.target).toEqual(HOME_ORBIT.target);
  });
});

describe('拡大・縮小(FR-101)', () => {
  it('ホイール 1 段で距離が 1.1 倍になる', () => {
    expect(zoom({ ...HOME_ORBIT, distance: 100 }, 100).distance).toBeCloseTo(110, 12);
  });

  it('逆向きのホイール 1 段で距離が 1.1 分の 1 になる', () => {
    expect(zoom({ ...HOME_ORBIT, distance: 100 }, -100).distance).toBeCloseTo(100 / 1.1, 12);
  });

  it('距離は下限と上限で止まる', () => {
    expect(zoom({ ...HOME_ORBIT, distance: MIN_DISTANCE }, -100_000).distance).toBe(MIN_DISTANCE);
    expect(zoom({ ...HOME_ORBIT, distance: MAX_DISTANCE }, 100_000).distance).toBe(MAX_DISTANCE);
  });
});

describe('ホーム視点(FR-108)', () => {
  /*
   * 2026-09-06 の既定の視点の変更(利用者の指示「初期状態は前と上と左右どちらかが
   * 見えた状態がいい」)で **Y の符号だけ**が反転した。3 成分の大きさが等しい(等角)ことも、
   * 仰角も距離も前と同じ。
   */
  it('等角視になり、カメラ位置は (+X, −Y, +Z) で 3 成分の大きさが等しい', () => {
    const [x, y, z] = cameraPosition(HOME_ORBIT);
    const expected = 200 / Math.sqrt(3);
    expect(expected).toBeCloseTo(115.47005383792515, 12);
    expect(x).toBeCloseTo(expected, 9);
    expect(y).toBeCloseTo(-expected, 9);
    expect(z).toBeCloseTo(expected, 9);
  });

  it('注視点をずらすとカメラ位置も同じだけずれる', () => {
    const [x, y, z] = cameraPosition({ ...HOME_ORBIT, target: [10, 20, 30] });
    const expected = 200 / Math.sqrt(3);
    expect(x).toBeCloseTo(expected + 10, 9);
    expect(y).toBeCloseTo(-expected + 20, 9);
    expect(z).toBeCloseTo(expected + 30, 9);
  });

  /*
   * 既定の視点で見えている 3 面(利用者の指示 2026-09-06)。面が見えているかどうかは
   * **面の法線と視線の内積の符号**で決まる。法線がカメラを向いている(内積が負)なら見える。
   * 原点に置いた箱 20³ でも、面の向きは箱の大きさに依らないので同じ判定になる。
   */
  it('前(−Y)・上(+Z)・右(+X)の 3 面が見え、後ろ・下・左の 3 面は見えない', () => {
    const direction = viewDirection(HOME_ORBIT);
    const dot = (normal: readonly [number, number, number]): number =>
      direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];

    // 見える 3 面。等角なので 3 つとも同じだけ傾く(−1/√3 = −0.5773502691896258)。
    const facing = -1 / Math.sqrt(3);
    expect(dot(HOME_VISIBLE_FACE_NORMALS.front)).toBeCloseTo(facing, 12);
    expect(dot(HOME_VISIBLE_FACE_NORMALS.top)).toBeCloseTo(facing, 12);
    expect(dot(HOME_VISIBLE_FACE_NORMALS.right)).toBeCloseTo(facing, 12);

    // 裏の 3 面(後ろ +Y・下 −Z・左 −X)は内積が正、つまりカメラに背を向けている。
    expect(dot([0, 1, 0])).toBeCloseTo(-facing, 12);
    expect(dot([0, 0, -1])).toBeCloseTo(-facing, 12);
    expect(dot([-1, 0, 0])).toBeCloseTo(-facing, 12);
  });

  /*
   * 「視点を戻す」(Home キーとビューキューブの家 → `goHome`)が既定の視点と同じ定数を
   * 使っていること。数を書き写した控えがもう 1 つ増えると、既定を変えたときに片方だけ
   * 古いままになる(P6 の名前付きビューでも同じ定数を使う)。`attachCameraControls` は
   * canvas を要る関数で、この package の検査は環境が node なので**原文を読んで**確かめる。
   */
  it('起動直後も「視点を戻す」も HOME_ORBIT ただ 1 つを使う', () => {
    const sourcePath = resolve(dirname(fileURLToPath(import.meta.url)), 'attachCameraControls.ts');
    const source = readFileSync(sourcePath, 'utf8');

    // 初期値・Home キー・goHome の 3 か所とも HOME_ORBIT を入れている。
    expect(source.match(/state(?::\s*OrbitState)?\s*=\s*HOME_ORBIT/g)).toHaveLength(3);
    // 方位角・仰角を書き写した控えがどこにも無い。
    expect(source).not.toMatch(/azimuth\s*:/);
    expect(source).not.toMatch(/elevation\s*:\s*Math\./);
  });
});

describe('平行移動(FR-101)', () => {
  it('1 ピクセルあたりの移動量が画角と距離から決まる', () => {
    // 導出: 2 × 100 × tan(25°) / 1000 = 0.0932615…(計画書の 0.0932602… は算出誤り。2026-09-02 統括承認)
    expect(worldUnitsPerPixel(100, 1000)).toBeCloseTo(0.0932615, 6);
  });

  it('真上から見ているとき、右へ 10 ピクセル動かすと注視点が -Y へ動く', () => {
    const state = { azimuth: 0, elevation: MAX_ELEVATION, distance: 100, target: [0, 0, 0] } as const;
    const moved = pan(state, 10, 0, 1000);
    const scale = worldUnitsPerPixel(100, 1000);
    expect(moved.target[0]).toBeCloseTo(0, 9);
    expect(moved.target[1]).toBeCloseTo(-10 * scale, 9);
    expect(moved.target[2]).toBeCloseTo(0, 9);
  });

  it('平行移動しても向きと距離は変わらない', () => {
    const moved = pan(HOME_ORBIT, 12, 34, 800);
    expect(moved.azimuth).toBe(HOME_ORBIT.azimuth);
    expect(moved.elevation).toBe(HOME_ORBIT.elevation);
    expect(moved.distance).toBe(HOME_ORBIT.distance);
  });
});

describe('投影の切り替え(FR-102)', () => {
  it('平行投影の表示高さは距離に比例する', () => {
    // 導出: 2 × 100 × tan(25°) = 93.26153…(計画書の 93.2602… は算出誤り。2026-09-02 統括承認)
    expect(orthographicFrustumHeight(100)).toBeCloseTo(93.26153, 4);
    expect(orthographicFrustumHeight(200)).toBeCloseTo(2 * 93.26153, 4);
  });
});

describe('名前の札の画面上の大きさ(P4 仕上げ (f)、統括の目視 2026-09-04)', () => {
  it('距離が 2 倍になれば、同じ画面の大きさを保つワールド高さも 2 倍になる', () => {
    const near = labelWorldHeight(13, 100, 800, 100);
    const far = labelWorldHeight(13, 200, 800, 100);
    expect(far).toBeCloseTo(near * 2, 12);
    // worldUnitsPerPixel と同じ式(orthographicFrustumHeight / viewportHeightPixels)を使うため、
    // 透視投影と平行投影で画面上の大きさがそろう。
    expect(near).toBeCloseTo(13 * worldUnitsPerPixel(100, 800), 12);
  });

  it('画面(ビューポート)が高いほど、同じ画素数に見せるワールド高さは小さくなる', () => {
    expect(labelWorldHeight(13, 100, 1600, 100)).toBeCloseTo(labelWorldHeight(13, 100, 800, 100) / 2, 12);
  });

  it('UI の拡大率が 150% なら、ワールド高さも 1.5 倍になる', () => {
    const base = labelWorldHeight(13, 100, 800, 100);
    expect(labelWorldHeight(13, 100, 800, 150)).toBeCloseTo(base * 1.5, 12);
  });
});

describe('clamp', () => {
  it('範囲の内外を正しく丸める', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
