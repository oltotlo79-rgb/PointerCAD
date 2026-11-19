/**
 * ブロック形の部品の台本(blockBracket.ts)の検査: 穴の無い箱・通し穴・座ぐり・直交して互いに貫く 2 つの座ぐりの体積が式と合う事、
 * 形が作れる事、想定の外の形(縁に掛かる穴・座ぐりの径や深さの誤り・平行に重なる穴・径の違う座ぐりの交わり・軸の交わらない重なり・
 * 3 本の重なり)を断る事。
 */
import { describe, expect, it } from 'vitest';

import { blockBracketVolume, buildBlockBracketPart, type BlockDimensions, type BlockHole } from './blockBracket.js';

const cylinder = (diameter: number, length: number): number => Math.PI * (diameter / 2) ** 2 * length;
const BOX = { width: 30, depth: 40, height: 55 } as const;
const TOP: BlockHole = { face: 'top', u: 15, v: 15, diameter: 9, counterbore: { diameter: 15, depth: 41 } };
const FRONT: BlockHole = { face: 'front', u: 15, v: 41, diameter: 9, counterbore: { diameter: 15, depth: 26 } };

describe('ブロック形の部品の台本', () => {
  it('穴の無い箱は幅 × 奥行 × 高さで、形が作れる', () => {
    const dims: BlockDimensions = { ...BOX, holes: [] };
    expect(blockBracketVolume(dims)).toBeCloseTo(30 * 40 * 55, 9);
    expect(buildBlockBracketPart(dims)).not.toBeNull();
  });

  it('上の面の通し穴は高さの分、座ぐりつきの穴は座ぐりと残りの通しの分だけ減る(面の向きごとに長さは向かいの面まで)', () => {
    const plain: BlockHole = { face: 'top', u: 15, v: 20, diameter: 9 };
    expect(blockBracketVolume({ ...BOX, holes: [plain] })).toBeCloseTo(30 * 40 * 55 - cylinder(9, 55), 9);
    expect(blockBracketVolume({ ...BOX, holes: [{ ...plain, face: 'right', u: 20, v: 30 }] })).toBeCloseTo(30 * 40 * 55 - cylinder(9, 30), 9);
    expect(blockBracketVolume({ ...BOX, holes: [FRONT] })).toBeCloseTo(30 * 40 * 55 - cylinder(15, 26) - cylinder(9, 14), 9);
  });

  it('上と前の同じ径の座ぐりが軸を直交させて交わり互いに貫く時は、2 つの円柱の共通部分 16/3·r³ を足し戻す', () => {
    const removed = cylinder(15, 41) + cylinder(9, 14) + cylinder(15, 26) + cylinder(9, 14);
    expect(blockBracketVolume({ ...BOX, holes: [TOP, FRONT] })).toBeCloseTo(30 * 40 * 55 - removed + (16 / 3) * 7.5 ** 3, 9);
    expect(buildBlockBracketPart({ ...BOX, holes: [TOP, FRONT] })).not.toBeNull();
  });

  it('交わらない 2 つの穴は重なりを足さない', () => {
    // 上の穴は左から 20、前の穴は左から 8 の低い位置: 円柱の外形の箱が、どの組でも重ならない(接するだけ)。
    const top: BlockHole = { ...TOP, u: 20, counterbore: { diameter: 15, depth: 10 } };
    const low: BlockHole = { ...FRONT, u: 8, v: 10, counterbore: { diameter: 15, depth: 5 } };
    expect(blockBracketVolume({ ...BOX, holes: [top, low] }))
      .toBeCloseTo(30 * 40 * 55 - cylinder(15, 10) - cylinder(9, 45) - cylinder(15, 5) - cylinder(9, 35), 9);
  });

  it('想定の外の形を断る', () => {
    const bads: readonly BlockHole[][] = [
      [{ ...TOP, u: 5 }],
      [{ ...TOP, counterbore: { diameter: 8, depth: 41 } }],
      [{ ...TOP, counterbore: { diameter: 15, depth: 55 } }],
      [TOP, { ...TOP, v: 20 }],
      [TOP, { ...FRONT, counterbore: { diameter: 14, depth: 26 } }],
      [TOP, { ...FRONT, u: 18 }],
      [TOP, FRONT, { face: 'right', u: 15, v: 41, diameter: 9, counterbore: { diameter: 15, depth: 20 } }],
    ];
    for (const holes of bads) {
      expect(blockBracketVolume({ ...BOX, holes }), JSON.stringify(holes)).toBeNull();
      expect(buildBlockBracketPart({ ...BOX, holes }), JSON.stringify(holes)).toBeNull();
    }
    expect(blockBracketVolume({ width: 0, depth: 40, height: 55, holes: [] })).toBeNull();
  });
});
