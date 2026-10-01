import { addComponent, createAssemblyDocument, createComponentFor, findComponent } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSEMBLY_MENU_ITEMS, assemblyMenuItems } from './assemblyMenuItems.js';
import { assemblyBuildReadiness, chooseAssemblyBuild } from './assemblyToolActions.js';
import { t } from '../../i18n/t.js';
import { resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';

function publishAssembly(): readonly string[] {
  let assembly = createAssemblyDocument('組立');
  assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'a' }));
  assembly = addComponent(assembly, createComponentFor(assembly, { kind: 'part', partRef: 'b' }));
  useAppStore.getState().openAssembly(assembly);
  return assembly.components.map(component => component.id);
}

function fixedMenuItem() {
  const { assembly, selection } = useAppStore.getState();
  if (assembly === null) throw new Error('Missing assembly');
  const items = assemblyMenuItems(assembly, selection);
  expect(items.map(item => item.id)).toEqual(ASSEMBLY_MENU_ITEMS.map(item => item.id));
  const item = items.find(item => item.id === 'toggleFixed');
  if (item === undefined) throw new Error('Missing fixed-state action');
  return item;
}

beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('組むメニューの固定操作', () => {
  it('固定・解除・Undo・Redoに次の操作名と説明が追従する', () => {
    const [, id] = publishAssembly();
    useAppStore.getState().setSelection([id]);
    const expectFixed = (fixed: boolean) => {
      const { assembly } = useAppStore.getState();
      if (assembly === null) throw new Error('Missing assembly');
      expect(findComponent(assembly, id)?.fixed).toBe(fixed);
      const item = fixedMenuItem();
      expect(t(item.labelKey)).toBe(fixed ? '固定を解除する' : '固定する');
      expect(t(item.tooltipKey)).toBe(fixed
        ? '選んだ部品の固定を解除して、動かせる状態にします。' : '選んだ部品を動かない状態にします。');
      expect(assemblyBuildReadiness(useAppStore.getState(), 'toggleFixed')).toEqual({ ready: true, reasonKey: null });
    };
    const reselectAfterHistory = () => {
      expect(useAppStore.getState().selection).toEqual([]);
      expect(fixedMenuItem().labelKey).toBe('assembly.tool.toggleFixed');
      expect(assemblyBuildReadiness(useAppStore.getState(), 'toggleFixed')).toEqual({ ready: false, reasonKey: 'assembly.tool.selectOneComponentReason' });
      useAppStore.getState().setSelection([id]);
    };
    expectFixed(false);
    chooseAssemblyBuild('toggleFixed');
    expectFixed(true);
    chooseAssemblyBuild('toggleFixed');
    expectFixed(false);
    useAppStore.getState().undo();
    reselectAfterHistory();
    expectFixed(true);
    useAppStore.getState().undo();
    reselectAfterHistory();
    expectFixed(false);
    useAppStore.getState().redo();
    reselectAfterHistory();
    expectFixed(true);
    useAppStore.getState().redo();
    reselectAfterHistory();
    expectFixed(false);
  });

  it('選ぶ部品を変えると名前が変わり、共有の定義を書き換えない', () => {
    const [fixed, free] = publishAssembly();
    useAppStore.getState().setSelection([fixed]);
    expect(fixedMenuItem().labelKey).toBe('assembly.tool.unfixComponent');
    useAppStore.getState().setSelection([free]);
    expect(fixedMenuItem().labelKey).toBe('assembly.tool.fixComponent');
    expect(ASSEMBLY_MENU_ITEMS.find(item => item.id === 'toggleFixed')?.labelKey).toBe('assembly.tool.fixComponent');
  });

  it.each(['empty', 'multiple', 'non-component'] as const)('%sの選択では1個選ぶ理由を示し、固定状態や履歴を変えない', selectionKind => {
    const ids = publishAssembly();
    useAppStore.getState().setSelection(selectionKind === 'empty' ? [] : selectionKind === 'multiple' ? ids : ['missing']);
    const before = useAppStore.getState();
    expect(fixedMenuItem().labelKey).toBe('assembly.tool.toggleFixed');
    expect(assemblyBuildReadiness(before, 'toggleFixed')).toEqual({ ready: false, reasonKey: 'assembly.tool.selectOneComponentReason' });
    expect(t('assembly.tool.selectOneComponentReason')).toBe('部品を1個選んでください。');
    chooseAssemblyBuild('toggleFixed');
    expect(useAppStore.getState()).toBe(before);
  });
});
