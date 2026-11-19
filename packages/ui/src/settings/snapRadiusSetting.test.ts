import { describe, expect, it } from 'vitest';

import { SNAP_RADIUS_PIXELS } from '../sketch/snapMath.js';
import { SUB_SHAPE_PICK_RADIUS_PIXELS } from '../solid/pickSubShape.js';
import {
  currentSnapRadius, DEFAULT_SNAP_RADIUS, pointSnapRadiusPixels, SNAP_RADIUS_CHOICES, snapRadiusChoiceOf, vertexSnapRadiusPixels,
} from './snapRadiusSetting.js';

/* 配置の補助 P-D: 吸着の幅の 3 段階(小・中・大 = 6・12・20 画素。統括の決定 2026-11-19 04:39)。 */
describe('吸着の幅', () => {
  it('選択肢は 小・中・大 の 3 つで、既定は 中', () => {
    expect(SNAP_RADIUS_CHOICES).toEqual(['small', 'medium', 'large']);
    expect(DEFAULT_SNAP_RADIUS).toBe('medium');
  });

  it('点の吸着は 6・12・20 画素で、既定(中)は今までの半径と同じ', () => {
    expect(pointSnapRadiusPixels({ snapRadius: 'small' })).toBe(6);
    expect(pointSnapRadiusPixels({ snapRadius: 'medium' })).toBe(12);
    expect(pointSnapRadiusPixels({ snapRadius: 'large' })).toBe(20);
    expect(pointSnapRadiusPixels(undefined)).toBe(SNAP_RADIUS_PIXELS);
  });

  it('部品の頂点への吸着は 3・6・10 画素で、既定(中)は今の部分形状の当たりの半径と同じ', () => {
    expect(vertexSnapRadiusPixels({ snapRadius: 'small' })).toBe(3);
    expect(vertexSnapRadiusPixels({ snapRadius: 'large' })).toBe(10);
    expect(vertexSnapRadiusPixels({})).toBe(SUB_SHAPE_PICK_RADIUS_PIXELS);
  });

  it('保存・設定ファイルの知らない値・形の違う値は読まず、設定の入口は既定へ戻す', () => {
    expect(snapRadiusChoiceOf('large')).toBe('large');
    for (const raw of ['huge', 12, null, undefined, { snapRadius: 'small' }]) expect(snapRadiusChoiceOf(raw)).toBeNull();
    expect(currentSnapRadius({})).toBe('medium');
  });
});
