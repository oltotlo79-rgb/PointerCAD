import { describe, expect, it } from 'vitest';
import { commandDefinition } from '../commands/commandDefinitions.js';
import { PARAMETER_TUTORIAL_STEPS, TUTORIAL_STEPS } from '../tutorial/tutorialProgress.js';
import { advanceScreenTour, type ScreenTourState } from './screenTourState.js';
import { TUTORIAL_STEP_COMMANDS } from './tutorialStepCommands.js';

function startTour(): Extract<ScreenTourState, { kind: 'step' }> {
  const { state } = advanceScreenTour(null, { type: 'start' });
  if (state?.kind !== 'step') throw new Error('Expected the first tour step');
  return state;
}

describe('advanceScreenTour', () => {
  it('visits the five locations in order before showing the tutorial offer', () => {
    let state: ScreenTourState = startTour();
    for (const step of [
      { kind: 'command', id: 'file.new' },
      { kind: 'command', id: 'toolbar.sketch.point' },
      { kind: 'region', id: 'history' },
      { kind: 'region', id: 'properties' },
      { kind: 'region', id: 'statusBar' },
    ]) {
      expect(state).toEqual({ kind: 'step', step, targetStatus: 'pending' });
      const transition = advanceScreenTour(state, { type: 'next' });
      expect(transition.seen).toBe(false);
      state = transition.state;
    }
    expect(state).toEqual({ kind: 'tutorialOffer' });
    expect(advanceScreenTour(state, { type: 'previous' })).toEqual({
      state: { kind: 'step', step: { kind: 'region', id: 'statusBar' }, targetStatus: 'pending' },
      seen: false,
    });
    expect(advanceScreenTour(state, { type: 'next' })).toEqual({ state: null, seen: true });
    expect(advanceScreenTour(null, { type: 'next' })).toEqual({ state: null, seen: false });
  });

  it('can return to the first step, where previous leaves the current visit intact', () => {
    const first = startTour();
    const second = advanceScreenTour(first, { type: 'next' }).state;
    expect(advanceScreenTour(second, { type: 'previous' })).toEqual({ state: first, seen: false });
    expect(advanceScreenTour(first, { type: 'previous' }).state).toBe(first);
    expect(advanceScreenTour(first, { type: 'start' }).state).toBe(first);
  });

  it('marks the tour as seen on Esc only while the tour is active', () => {
    expect(advanceScreenTour(startTour(), { type: 'dismiss' })).toEqual({ state: null, seen: true });
    expect(advanceScreenTour(null, { type: 'dismiss' })).toEqual({ state: null, seen: false });
  });

  it('closes on document replacement and can start over without recording completion', () => {
    const replaced = advanceScreenTour(startTour(), { type: 'documentChanged' });
    expect(replaced).toEqual({ state: null, seen: false });
    expect(advanceScreenTour(replaced.state, { type: 'start' }).state).toEqual(startTour());
  });

  it('keeps a missing target on the current step and moves on if the user presses next', () => {
    const first = startTour();
    const found = advanceScreenTour(first, { type: 'targetChanged', step: first.step, found: true });
    expect(found).toEqual({ state: { ...first, targetStatus: 'found' }, seen: false });
    const missing = advanceScreenTour(found.state, { type: 'targetChanged', step: first.step, found: false });
    expect(missing).toEqual({ state: { ...first, targetStatus: 'missing' }, seen: false });
    expect(advanceScreenTour(missing.state, { type: 'targetChanged', step: first.step, found: true }))
      .toEqual(found);
    expect(advanceScreenTour(missing.state, { type: 'next' })).toEqual({
      state: { kind: 'step', step: { kind: 'command', id: 'toolbar.sketch.point' }, targetStatus: 'pending' },
      seen: false,
    });
  });

  it('ignores observer callbacks from a previous visit to the same step', () => {
    const first = startTour();
    const second = advanceScreenTour(first, { type: 'next' }).state;
    const revisited = advanceScreenTour(second, { type: 'previous' }).state;
    expect(advanceScreenTour(revisited, { type: 'targetChanged', step: first.step, found: false }).state)
      .toBe(revisited);
  });
});

it('covers the current tutorial steps with registered toolbar commands and text-only completion', () => {
  const { plate, parameterToExport } = TUTORIAL_STEP_COMMANDS;
  expect(Object.keys(plate)).toEqual([...TUTORIAL_STEPS]);
  expect(Object.keys(parameterToExport)).toEqual([...PARAMETER_TUTORIAL_STEPS]);
  const targets = [...Object.entries(plate), ...Object.entries(parameterToExport)];
  for (const [step, commandId] of targets) {
    if (step === 'complete') {
      expect(commandId).toBeNull();
    } else {
      expect(commandId).not.toBeNull();
      expect(commandDefinition(commandId ?? '')?.id).toBe(commandId);
    }
  }
});
