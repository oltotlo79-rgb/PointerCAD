/**
 * 鋼材の断面の外形(J-01 包み 2)の検査: 代表の行は手で解いた外形と同じで(形の台本の多角形・円・資料の断面の原点)、
 * どの行も外形があり、資料の断面の行は断面の輪の全ての端点を含み、断面の幅・高さの欄と同じ大きさになる事。
 */
import { describe, expect, it } from 'vitest';

import { ALL_STEEL_PRODUCTS } from './steelCatalog.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import { steelSectionBounds } from './steelSectionBounds.js';

describe('鋼材の断面の外形', () => {
  it('代表の行は手で解いた外形(平鋼・丸鋼・鋼管は台本の多角形と円、角形鋼管は資料の断面の原点 (0, 0) から B × A)', () => {
    const flat = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'flatBar' && row.size === 'FB 50×6');
    const round = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'roundBar' && row.size === 'φ16');
    const pipe = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'steelPipe' && row.geometry !== 'profileSection');
    const tube = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'rectTube' && row.size === '□ 100×100×3.2');
    if (flat === undefined || round === undefined || pipe === undefined || tube === undefined) throw new Error('rows are missing');
    expect(steelSectionBounds(flat)).toEqual({ minX: 0, minY: 0, maxX: 50, maxY: 6 });
    expect(steelSectionBounds(round)).toEqual({ minX: -8, minY: -8, maxX: 8, maxY: 8 });
    const radius = (pipe.dimensions?.outsideDiameter ?? NaN) / 2;
    expect(steelSectionBounds(pipe)).toEqual({ minX: -radius, minY: -radius, maxX: radius, maxY: radius });
    const bounds = steelSectionBounds(tube);
    // 角の円弧の端は浮動小数の端数を持つので、近さで照らす。
    expect(bounds?.minX).toBeCloseTo(0, 9);
    expect(bounds?.minY).toBeCloseTo(0, 9);
    expect(bounds?.maxX).toBeCloseTo(100, 9);
    expect(bounds?.maxY).toBeCloseTo(100, 9);
  });

  it('どの行も外形があり、資料の断面の行は輪の全ての端点を含み、断面の幅・高さの欄と同じ大きさ', () => {
    for (const row of ALL_STEEL_PRODUCTS) {
      const bounds = steelSectionBounds(row);
      expect(bounds, row.key).not.toBeNull();
      if (bounds === null) continue;
      expect(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY, row.key).toBe(true);
      if (row.geometry !== 'profileSection') continue;
      const section = steelCatalogProfile(row.catalog, row.size);
      if (section === undefined) throw new Error(`no profile for ${row.key}`);
      for (const segment of section.segments) {
        for (const [x, y] of [segment.from, segment.to]) {
          expect(x >= bounds.minX - 1e-9 && x <= bounds.maxX + 1e-9 && y >= bounds.minY - 1e-9 && y <= bounds.maxY + 1e-9, row.key).toBe(true);
        }
      }
      expect(bounds.maxX - bounds.minX, row.key).toBeCloseTo(section.width, 6);
      expect(bounds.maxY - bounds.minY, row.key).toBeCloseTo(section.height, 6);
    }
  });
});
