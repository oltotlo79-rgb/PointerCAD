import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

function hasMethods(target: unknown, names: readonly string[]): boolean {
  return target !== null && (typeof target === 'function' || typeof target === 'object')
    && names.every(name => typeof Reflect.get(target, name) === 'function');
}

function hasConstructor(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'function') return false;
  const prototype: unknown = value.prototype;
  return hasMethods(prototype, methods);
}

/** Inspect the loaded embind module. The fixed declarations supply the signatures. */
export function hasIgesBindings(oc: OpenCascadeInstance): boolean {
  const modes = ['Perform_1', 'SetNameMode', 'SetColorMode', 'SetLayerMode', 'delete'];
  return 'IGESCAFControl_Reader_1' in oc
    && hasConstructor(oc.IGESCAFControl_Reader_1, [...modes, 'FileUnitFlag', 'FileUnitValue', 'FileScale'])
    && 'IGESCAFControl_Writer_1' in oc && hasConstructor(oc.IGESCAFControl_Writer_1, modes)
    && 'IGESControl_Writer' in oc
    && hasMethods(oc.IGESControl_Writer, ['WriteUnit', 'SetWriteUnit', 'WriteBRepMode', 'SetWriteBRepMode']);
}

export const IGES_UNAVAILABLE = 'この環境では IGES の読み書きに対応していません。';
