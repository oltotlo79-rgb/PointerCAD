/** Original, deliberately small host bridge for pcad-interface.c and QuickJS-ng.
 * The guest receives no host object. Temporary handles cannot escape callbacks. */
import { NativeScriptValue, NativeScriptException } from './nativeScriptValue.js';
export { NativeScriptValue, NativeScriptException } from './nativeScriptValue.js';
import { nativeScriptExports, type NativeScriptExports } from './nativeScriptExports.js';

interface NativeScriptOptions {
  readonly wasm: BufferSource;
  readonly memoryLimit: number;
  readonly maxStackSize: number;
  readonly timeMs: number;
  readonly interruptHandler: () => boolean;
  readonly onUnhandledRejection: (promise: { readonly identity: number }, reason: NativeScriptValue, handled: boolean) => void;
  readonly moduleLoader: { readonly normalize: (base: string, requested: string) => string; readonly load: (name: string) => string };
}
type HostFunction = (...args: NativeScriptValue[]) => NativeScriptValue;
const encoder = new TextEncoder(), decoder = new TextDecoder();

export class NativeScriptVm {
  private native: NativeScriptExports | undefined;
  private closed = false;
  private readonly callbacks: HostFunction[] = [];
  private callbackFailure: Error | undefined;
  private globals: NativeScriptValue[] = [];
  private constructor(private readonly options: NativeScriptOptions) {}

  static async create(options: NativeScriptOptions): Promise<NativeScriptVm> {
    const vm = new NativeScriptVm(options);
    const memory = (): WebAssembly.Memory => vm.exports.memory;
    const zeroPair = (first: number, second: number): number => {
      const view = new DataView(memory().buffer); view.setUint32(first, 0, true); view.setUint32(second, 0, true); return 0;
    };
    const imports = {
      pointercad: {
        interrupt: () => options.interruptHandler() ? 1 : 0,
        call: (callback: number, count: number, pointer: number) => vm.callHost(callback, count, pointer),
        rejection: (identity: number, reason: number, handled: number) => {
          const borrowed = new NativeScriptValue(vm, reason, false);
          try { options.onUnhandledRejection({ identity }, borrowed, handled !== 0); }
          catch (error) { vm.callbackFailure = error instanceof Error ? error : new Error('Script rejection callback failed', { cause: error }); }
          finally { borrowed.invalidate(); }
        },
        normalize: (base: number, requested: number) => {
          try { return vm.writeString(options.moduleLoader.normalize(vm.readCString(base), vm.readCString(requested))); }
          catch { return 0; }
        },
        load: (name: number) => {
          try { return vm.writeString(options.moduleLoader.load(vm.readCString(name))); }
          catch { return 0; }
        },
      },
      wasi_snapshot_preview1: {
        clock_time_get: (_clock: number, _precision: bigint, pointer: number) => {
          new DataView(memory().buffer).setBigUint64(pointer, BigInt(options.timeMs) * 1000000n, true); return 0;
        },
        environ_sizes_get: zeroPair, args_sizes_get: zeroPair,
        environ_get: () => 0, args_get: () => 0,
        fd_close: () => 8, fd_fdstat_get: () => 8, fd_seek: () => 8, fd_write: () => 8,
        proc_exit: (code: number): never => { throw new Error(`Script runtime exited: ${String(code)}`); },
      },
    };
    const { instance } = await WebAssembly.instantiate(options.wasm, imports);
    vm.native = nativeScriptExports(instance.exports);
    if (vm.exports.pcad_abi() !== 1) throw new Error('Unsupported PointerCAD script ABI');
    vm.exports._initialize();
    try {
      if (vm.exports.pcad_init(options.memoryLimit, options.maxStackSize) !== 1) throw new Error('Script runtime initialization failed');
      vm.globals = [vm.result(vm.exports.pcad_global()), ...[0, 1, 2].map(kind => vm.result(vm.exports.pcad_constant(kind)))];
      return vm;
    } catch (error) { vm.dispose(); throw error; }
  }

  get exports(): NativeScriptExports {
    if (this.closed || this.native === undefined) throw new Error('Script runtime is not available');
    return this.native;
  }
  get global(): NativeScriptValue { return this.constant(0); }
  get undefined(): NativeScriptValue { return this.constant(1); }
  get true(): NativeScriptValue { return this.constant(2); }
  get false(): NativeScriptValue { return this.constant(3); }
  private constant(index: number): NativeScriptValue {
    const value = this.globals[index]; if (value === undefined) throw new Error('Script runtime has no constants'); return value;
  }
  result(handle: number): NativeScriptValue {
    if (this.callbackFailure !== undefined) { const error = this.callbackFailure; this.callbackFailure = undefined; throw error; }
    if (handle === 0) throw new Error('Script value handle limit reached');
    const value = new NativeScriptValue(this, Math.abs(handle), true);
    if (handle < 0) throw new NativeScriptException(value);
    return value;
  }
  private readCString(pointer: number): string {
    const bytes = new Uint8Array(this.exports.memory.buffer);
    const end = bytes.indexOf(0, pointer);
    if (pointer <= 0 || end < pointer || end - pointer > 1024 * 1024) throw new Error('Invalid script string');
    return decoder.decode(bytes.subarray(pointer, end));
  }
  private writeString(text: string): number {
    const bytes = encoder.encode(text), pointer = this.exports.malloc(bytes.length + 1);
    if (!pointer) throw new Error('Script bridge allocation failed');
    const memory = new Uint8Array(this.exports.memory.buffer);
    memory.set(bytes, pointer); memory[pointer + bytes.length] = 0;
    return pointer;
  }
  private text<T>(value: string, operation: (pointer: number, length: number) => T): T {
    const pointer = this.writeString(value);
    try { return operation(pointer, encoder.encode(value).length); }
    finally { this.exports.free(pointer); }
  }
  readString(handle: number): string {
    const length = this.exports.malloc(4); if (!length) throw new Error('Script bridge allocation failed');
    let pointer = 0;
    try {
      pointer = this.exports.pcad_string_data(handle, length);
      if (!pointer) throw new Error('Script value is not a primitive string');
      const size = new DataView(this.exports.memory.buffer).getUint32(length, true);
      // Inputs/commands have their own smaller checks. A VM heap cannot provide a larger string.
      if (size > this.options.memoryLimit) throw new Error('Script string exceeds heap boundary');
      return decoder.decode(new Uint8Array(this.exports.memory.buffer, pointer, size));
    } finally { if (pointer) this.exports.pcad_string_free(pointer); this.exports.free(length); }
  }
  newString(value: string): NativeScriptValue { return this.text(value, (pointer, length) => this.result(this.exports.pcad_string(pointer, length))); }
  newNumber(value: number): NativeScriptValue { return this.result(this.exports.pcad_number(value)); }
  newFunction(name: string, callback: HostFunction): NativeScriptValue {
    if (this.callbacks.length >= 64) throw new Error('Script host callback limit reached');
    const id = this.callbacks.push(callback) - 1;
    return this.text(name, pointer => this.result(this.exports.pcad_function(pointer, id)));
  }
  private callHost(id: number, count: number, pointer: number): number {
    const borrowed: NativeScriptValue[] = [];
    try {
      const callback = this.callbacks[id]; if (!callback || count < 0 || count > 64) throw new Error('Unknown script host callback');
      const data = new DataView(this.exports.memory.buffer);
      for (let index = 0; index < count; index++) borrowed.push(new NativeScriptValue(this, data.getUint32(pointer + index * 4, true), false));
      return callback(...borrowed).handleFor(this);
    } catch (error) { this.callbackFailure = error instanceof Error ? error : new Error('Script host callback failed', { cause: error }); return 0; }
    finally { for (const value of borrowed) value.invalidate(); }
  }
  set(target: NativeScriptValue, name: string, source: NativeScriptValue): void {
    this.text(name, pointer => this.result(this.exports.pcad_set(target.handleFor(this), pointer, source.handleFor(this))).dispose());
  }
  evalCode(source: string, name: string, module = false): NativeScriptValue {
    return this.text(name, file => this.text(source, (text, length) => this.result(this.exports.pcad_eval(text, length, file, module ? 1 : 0))));
  }
  callFunction(callback: NativeScriptValue, receiver: NativeScriptValue, ...args: NativeScriptValue[]): NativeScriptValue {
    if (args.length > 64) throw new Error('Too many script arguments');
    const pointer = this.exports.malloc(Math.max(1, args.length) * 4); if (!pointer) throw new Error('Script bridge allocation failed');
    try {
      const data = new DataView(this.exports.memory.buffer);
      args.forEach((value, index) => data.setUint32(pointer + index * 4, value.handleFor(this), true));
      return this.result(this.exports.pcad_call(callback.handleFor(this), receiver.handleFor(this), args.length, pointer));
    } finally { this.exports.free(pointer); }
  }
  executePendingJobs(): void {
    for (;;) {
      if (this.options.interruptHandler()) return;
      const result = this.exports.pcad_job();
      if (result < 0) this.result(result);
      if (this.callbackFailure !== undefined) { const error = this.callbackFailure; this.callbackFailure = undefined; throw error; }
      if (result === 0) return;
    }
  }
  markPromiseHandled(value: NativeScriptValue): void { this.exports.pcad_promise_handled(value.handleFor(this)); }
  settled(value: NativeScriptValue): { value: NativeScriptValue } | { error: NativeScriptValue } | undefined {
    const handle = value.handleFor(this), state = this.exports.pcad_promise_state(handle);
    if (state === -1) return { value: value.dup() };
    if (state === 0) return undefined;
    const result = this.result(this.exports.pcad_promise_result(handle));
    if (state === 1) return { value: result };
    if (state === 2) return { error: result };
    result.dispose(); throw new Error('Invalid promise state');
  }
  _getExports(): NativeScriptExports { return this.exports; }
  dispose(): void {
    if (this.closed) return;
    if (this.native !== undefined) this.native.pcad_close();
    this.closed = true; this.callbacks.length = 0; this.globals.length = 0;
  }
}
