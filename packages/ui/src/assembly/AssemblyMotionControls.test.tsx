import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addComponent, createAssemblyDocument, createComponentFor, resolveAssembly,
  type JointFrame,
} from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { AssemblyPropertyPanel, assemblyPropertyKey } from './AssemblyPropertyPanel.js';
import { AssemblyMotionControls } from './AssemblyMotionControls.js';

const FRAME: JointFrame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function publishJoint(): void {
  let document = createAssemblyDocument('motion');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'a' }, { partName: 'A' }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'b' }, { partName: 'B' }));
  const a = document.components[0].id, b = document.components[1].id;
  document = { ...document, joints: [{ id: 'joint-1', name: 'joint1', kind: 'revolute',
    a: { kind: 'origin', componentId: a, element: 'z' },
    b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false }] };
  useAppStore.getState().openAssembly(document);
  useAppStore.setState({ selection: ['joint-1'], assemblyView: { sourceDocument: document,
    resolved: resolveAssembly(document), bodies: new Map(), appearances: new Map(), diagnosis: null,
    mateTargetErrors: new Map(), mateTargets: new Map(), jointFrames: new Map([['joint-1', { a: FRAME, b: FRAME }]]) } });
}

function markup(component: () => React.JSX.Element | null): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(component)); } finally { snapshot.mockRestore(); }
}

beforeEach(resetTestStore);

describe('P7-22 joint sliders in both existing UI regions', () => {
  it('renders the selected joint slider in the viewport controls', () => {
    publishJoint();
    const html = markup(AssemblyMotionControls);
    expect(html).toContain('id="viewport-joint-1-angle"');
    expect(html).toContain('type="range"');
  });
  it('renders the same joint coordinate in the property panel with a distinct DOM id', () => {
    publishJoint();
    const html = markup(AssemblyPropertyPanel);
    expect(html).toContain('id="property-joint-1-angle"');
    expect(html).not.toContain('id="viewport-joint-1-angle"');
  });
  it('prefixes every sibling property section key', () => {
    const kinds: readonly ('component' | 'mate' | 'joint' | 'step')[] = ['component', 'mate', 'joint', 'step'];
    expect(kinds.map((kind) => assemblyPropertyKey(kind, 'same')))
      .toEqual(['component:same', 'mate:same', 'joint:same', 'step:same']);
  });
});
