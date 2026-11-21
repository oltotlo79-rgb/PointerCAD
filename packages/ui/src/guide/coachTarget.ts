import type { ScreenRect } from '../solid/faceScreenRect.js';
import { firstFittingPopover, POPOVER_GAP, POPOVER_INSET } from '../shell/popoverPlacement.js';

type Size = Readonly<{ width: number; height: number }>;

interface CoachCandidates {
  readonly commands: readonly { readonly commandId: string; readonly rect: ScreenRect | null }[];
  readonly collapsedGroups: readonly {
    readonly groupId: string;
    readonly commandIds: readonly string[];
    readonly rect: ScreenRect;
  }[];
}

type CoachTarget =
  | { readonly kind: 'command'; readonly rect: ScreenRect }
  | { readonly kind: 'group'; readonly groupId: string; readonly rect: ScreenRect }
  | { readonly kind: 'text' };

/** A null rectangle represents a hidden button. Include only visible openers for collapsed groups. */
export function findCoachTarget(commandId: string, candidates: CoachCandidates): CoachTarget {
  const command = candidates.commands.find(candidate =>
    candidate.commandId === commandId && candidate.rect !== null);
  if (command?.rect) return { kind: 'command', rect: command.rect };
  const group = candidates.collapsedGroups.find(candidate => candidate.commandIds.includes(commandId));
  if (group !== undefined) return { kind: 'group', groupId: group.groupId, rect: group.rect };
  return { kind: 'text' };
}

const VIEWPORT_ORIGIN_PIXELS = 0;

interface PopoverPlacement {
  readonly left: number;
  readonly top: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly placement: 'below' | 'above' | 'right' | 'left' | 'clamped';
}

function axisBounds(viewportSize: number, popoverSize: number) {
  const margin = viewportSize > POPOVER_INSET * 2 ? POPOVER_INSET : VIEWPORT_ORIGIN_PIXELS;
  const maxSize = viewportSize - margin * 2;
  return { min: margin, max: viewportSize - margin - Math.min(popoverSize, maxSize), maxSize };
}

function clamp(position: number, min: number, max: number): number {
  return Math.min(Math.max(min, position), max);
}

/** Position a measured bubble in viewport pixels. Apply the returned size limits to its border box. */
export function placeCoachPopover(target: ScreenRect, popover: Size, viewport: Size): PopoverPlacement {
  const horizontal = axisBounds(viewport.width, popover.width);
  const vertical = axisBounds(viewport.height, popover.height);
  const maxWidth = horizontal.maxSize;
  const maxHeight = vertical.maxSize;
  const left = clamp((target.left + target.right - Math.min(popover.width, maxWidth)) / 2,
    horizontal.min, horizontal.max);
  const top = clamp((target.top + target.bottom - Math.min(popover.height, maxHeight)) / 2,
    vertical.min, vertical.max);
  const fit = firstFittingPopover(['below', 'above', 'right', 'left'], target, { left, top }, popover, viewport,
    { inset: { left: horizontal.min, top: vertical.min } });
  if (fit) return { ...fit, maxWidth, maxHeight };
  return { left, top: clamp(target.bottom + POPOVER_GAP, vertical.min, vertical.max), maxWidth, maxHeight, placement: 'clamped' };
}
