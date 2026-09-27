import type { NativeScriptVm } from './nativeScriptVm.js';

/** Values are owned by exactly one module instance and have an explicit lifetime. */
export class NativeScriptValue {
  private live = true;
  constructor(private readonly owner: NativeScriptVm, private readonly handle: number, private readonly owned: boolean) {}
  handleFor(owner: NativeScriptVm): number {
    if (!this.live || owner !== this.owner) throw new Error('Expired or foreign script value');
    void owner.exports;
    return this.handle;
  }
  get isString(): boolean { return this.owner.exports.pcad_is_string(this.handleFor(this.owner)) !== 0; }
  get isError(): boolean { return this.owner.exports.pcad_is_error(this.handleFor(this.owner)) !== 0; }
  toString(): string { return this.owner.readString(this.handleFor(this.owner)); }
  dup(): NativeScriptValue { return this.owner.result(this.owner.exports.pcad_dup(this.handleFor(this.owner))); }
  setProp(name: string, value: NativeScriptValue): void { this.owner.set(this, name, value); }
  consume<T>(read: (value: NativeScriptValue) => T): T { try { return read(this); } finally { this.dispose(); } }
  invalidate(): void { this.live = false; }
  dispose(): void {
    if (!this.live) return;
    if (this.owned) this.owner.exports.pcad_release(this.handle);
    this.live = false;
  }
}
export class NativeScriptException extends Error {
  constructor(readonly handle: NativeScriptValue) { super('Script execution failed'); }
  dispose(): void { this.handle.dispose(); }
}
