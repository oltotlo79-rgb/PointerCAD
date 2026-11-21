import { describe, expect, it } from 'vitest';
import { findCoachTarget, placeCoachPopover } from './coachTarget.js';

const COMMAND_ID = 'toolbar.shape.rectangle';
const BUTTON_RECT = { left: 100, top: 60, right: 120, bottom: 80 };
const OPENER_RECT = { left: 80, top: 20, right: 120, bottom: 40 };
const COLLAPSED_GROUPS = [{ groupId: 'shape', commandIds: [COMMAND_ID], rect: OPENER_RECT }];

describe('findCoachTarget', () => {
  it('prefers the matching visible button to hidden copies and collapsed groups', () => {
    expect(findCoachTarget(COMMAND_ID, {
      commands: [
        { commandId: COMMAND_ID, rect: null },
        { commandId: 'file.new', rect: OPENER_RECT },
        { commandId: COMMAND_ID, rect: BUTTON_RECT },
      ],
      collapsedGroups: COLLAPSED_GROUPS,
    })).toEqual({ kind: 'command', rect: BUTTON_RECT });
  });

  it('identifies the closed group by membership even when its button is unmounted', () => {
    const collapsedGroups = [
      { groupId: 'file', commandIds: ['file.new'], rect: BUTTON_RECT },
      ...COLLAPSED_GROUPS,
    ];
    expect(findCoachTarget(COMMAND_ID, { commands: [], collapsedGroups }))
      .toEqual({ kind: 'group', groupId: 'shape', rect: OPENER_RECT });
  });

  it('falls back to text when the command has no visible button or closed group opener', () => {
    expect(findCoachTarget(COMMAND_ID, {
      commands: [{ commandId: COMMAND_ID, rect: null }],
      collapsedGroups: [],
    })).toEqual({ kind: 'text' });
  });
});

const VIEWPORT = { width: 300, height: 200 };
const POPOVER = { width: 100, height: 60 };

describe('placeCoachPopover', () => {
  it.each([
    { target: { left: 8, top: 8, right: 28, bottom: 28 }, placement: 'below', left: 8, top: 42 },
    { target: { left: 272, top: 8, right: 292, bottom: 28 }, placement: 'below', left: 192, top: 42 },
    { target: { left: 8, top: 172, right: 28, bottom: 192 }, placement: 'above', left: 8, top: 98 },
    { target: { left: 272, top: 172, right: 292, bottom: 192 }, placement: 'above', left: 192, top: 98 },
  ])('uses $placement and keeps the bubble inset at ($target.left, $target.top)', ({
    target, placement, left, top,
  }) => {
    expect(placeCoachPopover(target, POPOVER, VIEWPORT))
      .toEqual({ placement, left, top, maxWidth: 284, maxHeight: 184 });
  });

  it('prefers below when both vertical sides fit and accepts exact inset contact', () => {
    const target = { left: 140, top: 86, right: 160, bottom: 118 };
    expect(placeCoachPopover(target, POPOVER, VIEWPORT)).toMatchObject({
      placement: 'below', left: 100, top: 132,
    });
  });

  it('tries right then left when neither vertical side fits', () => {
    const centered = { left: 125, top: 60, right: 150, bottom: 150 };
    expect(placeCoachPopover(centered, POPOVER, VIEWPORT)).toMatchObject({
      placement: 'right', left: 164, top: 75,
    });
    const nearRight = { ...centered, left: 230, right: 260 };
    expect(placeCoachPopover(nearRight, POPOVER, VIEWPORT)).toMatchObject({
      placement: 'left', left: 116, top: 75,
    });
  });

  it('marks a clamped placement when the target leaves no room on any side', () => {
    const target = { left: 8, top: 8, right: 292, bottom: 192 };
    expect(placeCoachPopover(target, POPOVER, VIEWPORT)).toMatchObject({
      placement: 'clamped', left: 100, top: 132,
    });
  });

  it('limits both dimensions and drops a margin that would occupy the entire axis', () => {
    const viewport = { width: 64, height: 12 };
    const outside = { left: 65, top: -30, right: 85, bottom: -10 };
    expect(placeCoachPopover(outside, POPOVER, viewport))
      .toEqual({ placement: 'clamped', left: 8, top: 0, maxWidth: 48, maxHeight: 12 });
  });
});
