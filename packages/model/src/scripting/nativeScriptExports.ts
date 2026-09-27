/** Explicit ABI guard: an upstream/different binary cannot silently weaken limits. */
export interface NativeScriptExports {
  readonly memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  pcad_abi(): number;
  pcad_init(memory: number, stack: number): number;
  pcad_close(): void;
  pcad_global(): number;
  pcad_constant(kind: number): number;
  pcad_number(value: number): number;
  pcad_string(pointer: number, length: number): number;
  pcad_release(handle: number): void;
  pcad_dup(handle: number): number;
  pcad_is_string(handle: number): number;
  pcad_is_error(handle: number): number;
  pcad_string_data(handle: number, length: number): number;
  pcad_string_free(pointer: number): void;
  pcad_function(name: number, callback: number): number;
  pcad_set(target: number, name: number, source: number): number;
  pcad_eval(source: number, length: number, file: number, module: number): number;
  pcad_call(callback: number, receiver: number, count: number, args: number): number;
  pcad_job(): number;
  pcad_promise_state(handle: number): number;
  pcad_promise_result(handle: number): number;
  pcad_promise_handled(handle: number): void;
  pointercad_resource_failure(): number;
  pointercad_resource_line(): number;
  pointercad_resource_column(): number;
  pointercad_resource_file_byte(index: number): number;
}
function isNative(value: object): value is NativeScriptExports {
  const functions = ['_initialize', 'malloc', 'free', 'pcad_abi', 'pcad_init', 'pcad_close', 'pcad_global', 'pcad_constant',
    'pcad_number', 'pcad_string', 'pcad_release', 'pcad_dup', 'pcad_is_string', 'pcad_is_error', 'pcad_string_data',
    'pcad_string_free', 'pcad_function', 'pcad_set', 'pcad_eval', 'pcad_call', 'pcad_job', 'pcad_promise_state',
    'pcad_promise_result', 'pcad_promise_handled', 'pointercad_resource_failure', 'pointercad_resource_line',
    'pointercad_resource_column', 'pointercad_resource_file_byte'];
  return 'memory' in value && value.memory instanceof WebAssembly.Memory
    && functions.every(name => name in value && typeof Reflect.get(value, name) === 'function');
}
export function nativeScriptExports(value: object): NativeScriptExports {
  if (!isNative(value)) throw new Error('Required PointerCAD script boundary and resource limits are missing');
  return value;
}
