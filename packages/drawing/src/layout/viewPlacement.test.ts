import { describe, expect, it } from 'vitest';
import type { DrawingView } from '../types.js';
import { effectiveViewScale, moveView, snapToAligned, viewTitle } from './viewPlacement.js';

const view: DrawingView = { id: 'v', name: 'A', kind: 'top', position: [100, 100], scale: null,
  direction: [0, 0, -1], xDir: [1, 0, 0], showHidden: true, showCenterLines: true, layerId: 'layer-1' };

describe('図の位置と縮尺', () => {
  const guides = [{ axis: 'u' as const, coordinate: 100 }];
  it('横へ1mmなら同じuへ吸着', () => expect(moveView(view, [1, 0], guides).position).toEqual([100, 100]));
  it('横へ3mmなら吸着しない', () => expect(moveView(view, [3, 0], guides).position).toEqual([103, 100]));
  it('そろえるを切れば1mmでも吸着しない', () => expect(moveView(view, [1, 0], guides, false).position).toEqual([101, 100]));
  it('uとvを独立に最寄りへ吸着', () => expect(snapToAligned([9, 21], [
    { axis: 'u', coordinate: 10 }, { axis: 'v', coordinate: 20 },
  ])).toEqual([10, 20]));
  it('nullは図面の縮尺を継ぐ', () => expect(effectiveViewScale(null, 0.5)).toBe(0.5));
  it('個別縮尺を優先する', () => expect(effectiveViewScale(2, 0.5)).toBe(2));
  it('異なる縮尺だけ見出しへ出す', () => expect(viewTitle('A', 2, 1)).toBe('A (2:1)'));
  it('同じ縮尺は見出しへ出さない', () => expect(viewTitle('A', 1, 1)).toBe('A'));
  it('遠い案内線へ順に飛び移らず、元の位置に最も近い線へそろえる', () => {
    expect(snapToAligned([0, 0], [{ axis: 'u', coordinate: 1 }, { axis: 'u', coordinate: 1.5 }])).toEqual([1, 0]);
  });
  it('2mmちょうどは吸着範囲に含む', () => expect(snapToAligned([102, 100], guides)).toEqual([100, 100]));
  it('移動で元の図や縮尺を変えない', () => {
    const moved = moveView(view, [3, 5]);
    expect(view.position).toEqual([100, 100]);
    expect(moved).toEqual({ ...view, position: [103, 105] });
  });
});
