import { expect, it } from 'vitest';
import { firstFittingPopover } from './popoverPlacement.js';

const rect = { left: 40, top: 40, right: 60, bottom: 60 };
const point = { left: 8, top: 8 };
const size = { width: 18, height: 18 };
const viewport = { width: 100, height: 100 };

it('accepts exact clearance and follows the supplied order and alignment', () => {
  expect(firstFittingPopover(['right', 'below'], rect, point, size, viewport))
    .toEqual({ placement: 'right', left: 74, top: 8 });
  expect(firstFittingPopover(['below', 'right'], rect, point, size, viewport))
    .toEqual({ placement: 'below', left: 8, top: 74 });
});

it('rejects a candidate when its aligned axis overflows and tries the next side', () => {
  expect(firstFittingPopover(['left', 'above'], rect, { left: 8, top: 7 }, size, viewport))
    .toEqual({ placement: 'above', left: 8, top: 8 });
  expect(firstFittingPopover(['left'], rect, { left: 8, top: 7 }, size, viewport)).toBeNull();
});

it('lets an attached list touch its field and the viewport edge', () => {
  const flush = { inset: { left: 0, top: 0 }, gap: 0 };
  expect(firstFittingPopover(['below', 'above'], rect, { left: 0, top: 0 }, { width: 18, height: 40 }, viewport, flush))
    .toEqual({ placement: 'below', left: 0, top: 60 });
  const low = { left: 40, top: 50, right: 60, bottom: 70 };
  expect(firstFittingPopover(['below', 'above'], low, { left: 0, top: 0 }, { width: 18, height: 50 }, viewport, flush))
    .toEqual({ placement: 'above', left: 0, top: 0 });
  expect(firstFittingPopover(['below', 'above'], low, { left: 0, top: 0 }, { width: 18, height: 51 }, viewport, flush)).toBeNull();
});
