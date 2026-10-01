import { describe, expect, it } from 'vitest';
import {
  COMMAND_DEFINITIONS,
  currentShortcutList,
  resolveShortcut,
  type CommandKeyContext,
  type CommandKeyInput,
} from './commandDefinitions.js';

const input = (key: string, values: Partial<CommandKeyInput> = {}): CommandKeyInput => ({
  key, ctrl: false, meta: false, alt: false, shift: false, repeat: false, ...values,
});

const context = (values: Partial<CommandKeyContext> = {}): CommandKeyContext => ({
  documentKind: 'part', phase: 'bubble', helpOpen: false, textEntry: false, composing: false,
  activatedBySpace: false, insideMenu: false, insideDialog: false, ...values,
});

describe('command definitions', () => {
  it('has no duplicate command IDs and publishes every binding in the generated list', () => {
    const ids = COMMAND_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(currentShortcutList()).toHaveLength(22);
    expect(currentShortcutList().every((entry) => ids.includes(entry.commandId))).toBe(true);
    for (const definition of COMMAND_DEFINITIONS) {
      for (const binding of definition.shortcuts) {
        expect(binding.documentKinds.every(kind => definition.documentKinds.includes(kind))).toBe(true);
      }
    }
  });

  it('keeps all existing file and history chords and adds Cmd history for parts', () => {
    expect(resolveShortcut(input('s', { ctrl: true }), context())?.commandId).toBe('file.save');
    expect(resolveShortcut(input('S', { meta: true, shift: true }), context({ documentKind: 'drawing' }))?.commandId).toBe('file.saveAs');
    expect(resolveShortcut(input('o', { meta: true }), context())?.commandId).toBe('file.open');
    expect(resolveShortcut(input('n', { ctrl: true }), context())?.commandId).toBe('file.new');
    expect(resolveShortcut(input('z', { ctrl: true }), context())?.commandId).toBe('history.undo');
    expect(resolveShortcut(input('y', { ctrl: true }), context())?.commandId).toBe('history.redo');
    expect(resolveShortcut(input('z', { ctrl: true, shift: true }), context())?.commandId).toBe('history.redo');
    expect(resolveShortcut(input('z', { meta: true }), context())?.commandId).toBe('history.undo');
    expect(resolveShortcut(input('z', { meta: true }), context({ documentKind: 'drawing' }))?.commandId).toBe('history.undo');
  });

  it.each(['part', 'assembly', 'drawing'] as const)('uses Ctrl and Cmd history consistently in %s without taking text editing', documentKind => {
    const chords = [
      { key: 'z', shift: false, commandId: 'history.undo', display: 'Ctrl/Cmd+Z' },
      { key: 'y', shift: false, commandId: 'history.redo', display: 'Ctrl/Cmd+Y' },
      { key: 'y', shift: true, commandId: 'history.redo', display: 'Ctrl/Cmd+Y' },
      { key: 'z', shift: true, commandId: 'history.redo', display: 'Ctrl/Cmd+Shift+Z' },
    ] as const;
    for (const modifier of [{ ctrl: true }, { meta: true }]) {
      for (const chord of chords) {
        const key = input(chord.key, { ...modifier, shift: chord.shift });
        const result = resolveShortcut(key, context({ documentKind }));
        expect(result?.commandId).toBe(chord.commandId);
        expect(result?.binding.display).toBe(chord.display);
        for (const blocked of [{ textEntry: true }, { composing: true }, { insideDialog: true }, { helpOpen: true }]) {
          expect(resolveShortcut(key, context({ documentKind, ...blocked }))).toBeNull();
        }
        expect(resolveShortcut({ ...key, alt: true }, context({ documentKind }))).toBeNull();
      }
    }
    expect(resolveShortcut(input('z'), context({ documentKind }))).toBeNull();
    expect(resolveShortcut(input('y'), context({ documentKind }))).toBeNull();
  });

  it('does not take editing, IME, menu, repeat, or dialog keys', () => {
    const editing = context({ textEntry: true });
    for (const key of ['z', 'y', '1', '2', '3', '4', ' ']) {
      expect(resolveShortcut(input(key, { ctrl: key === 'z' || key === 'y' }), editing)).toBeNull();
    }
    for (const key of ['Enter', 'Delete', 'Backspace']) {
      expect(resolveShortcut(input(key), context({ documentKind: 'drawing', textEntry: true }))).toBeNull();
    }
    expect(resolveShortcut(input('Enter'), context({ documentKind: 'drawing', composing: true }))).toBeNull();
    expect(resolveShortcut(input('Enter', { repeat: true }), context({ documentKind: 'drawing' }))).toBeNull();
    expect(resolveShortcut(input(' '), context({ activatedBySpace: true }))).toBeNull();
    expect(resolveShortcut(input('Escape'), context({ phase: 'capture', insideMenu: true }))).toBeNull();
    expect(resolveShortcut(input('s', { ctrl: true }), context({ insideDialog: true }))).toBeNull();
  });

  it('preserves Ctrl/Cmd+S in text fields and during IME composition', () => {
    const composingInput = context({ textEntry: true, composing: true });
    expect(resolveShortcut(input('s', { ctrl: true }), composingInput)?.commandId).toBe('file.save');
    expect(resolveShortcut(input('s', { meta: true, shift: true }), composingInput)?.commandId).toBe('file.saveAs');
  });

  it('uses capture F1 in every context and blocks ordinary keys while help is open', () => {
    const help = context({ phase: 'capture', helpOpen: true, textEntry: true, composing: true, insideDialog: true });
    expect(resolveShortcut(input('F1'), help)?.commandId).toBe('help.contextual');
    expect(resolveShortcut(input('s', { ctrl: true }), context({ helpOpen: true }))).toBeNull();
  });

  it('keeps drawing-only and part/assembly-only plain keys separate', () => {
    expect(resolveShortcut(input('Enter'), context({ documentKind: 'drawing' }))?.commandId).toBe('drawing.commitDimension');
    expect(resolveShortcut(input('Delete'), context({ documentKind: 'drawing' }))?.commandId).toBe('drawing.deleteSelection');
    expect(resolveShortcut(input('3'), context())?.commandId).toBe('selection.face');
    expect(resolveShortcut(input(' '), context({ documentKind: 'assembly' }))?.commandId).toBe('commandLine.focus');
    expect(resolveShortcut(input('3'), context({ documentKind: 'drawing' }))).toBeNull();
  });
});
