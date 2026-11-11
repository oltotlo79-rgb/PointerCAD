import { describe, expect, expectTypeOf, it } from 'vitest';
import { fileFailure, parseFailure } from './codedFailure.js';
import type { ParseDocumentResult, ParseErrorCode } from './documentJson.js';
import type { ReadAssemblyDocumentResult } from './assemblyJson.js';
import type { ParseDrawingResult } from './drawingJson.js';
import type {
  ReadPcadFileErrorCode, ReadPcadFileResult, ReadPcadaFileResult, ReadPcaddFileResult,
} from './pcadFile.js';

const constructors: readonly { readonly name: string; readonly make: typeof parseFailure | typeof fileFailure }[] = [
  { name: 'parse', make: parseFailure },
  { name: 'archive', make: fileFailure },
];

for (const { name, make } of constructors) {
  describe(name, () => {
    it('preserves exact data properties, enumeration order and message bytes', () => {
      const result = make('invalidJson', '破損\n(document.名前)\u0000');
      expect(result).toStrictEqual({ ok: false, error: { code: 'invalidJson', message: '破損\n(document.名前)\u0000' } });
      expect(Object.keys(result)).toEqual(['ok', 'error']);
      expect(Object.keys(result.error)).toEqual(['code', 'message']);
      expect(Object.getOwnPropertyDescriptors(result.error)).toEqual({
        code: { value: 'invalidJson', writable: true, enumerable: true, configurable: true },
        message: { value: '破損\n(document.名前)\u0000', writable: true, enumerable: true, configurable: true },
      });
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(result.error)).toBe(Object.prototype);
    });

    it('allocates both result and error afresh', () => {
      const first = make('missingField', 'missing');
      const second = make('missingField', 'missing');
      expect(first).not.toBe(second);
      expect(first.error).not.toBe(second.error);
      expect(first).toStrictEqual(second);
    });

    it('evaluates arguments once in order and preserves a thrown accessor object', () => {
      const trace: string[] = [];
      const values = {
        get code(): ParseErrorCode { trace.push('code'); return 'invalidField'; },
        get message(): string { trace.push('message'); return 'message'; },
      };
      expect(make(values.code, values.message).error).toEqual({ code: 'invalidField', message: 'message' });
      expect(trace).toEqual(['code', 'message']);
      trace.length = 0;
      const thrown = new Error('caller failure');
      const broken = { get code(): ParseErrorCode { trace.push('throw'); throw thrown; } };
      let caught: unknown;
      try { make(broken.code, values.message); } catch (error: unknown) { caught = error; }
      expect(caught).toBe(thrown);
      expect(trace).toEqual(['throw']);
    });
  });
}

it('retains the six existing failure branches and separate accepted code sets', () => {
  expectTypeOf(parseFailure).parameter(0).toEqualTypeOf<ParseErrorCode>();
  expectTypeOf(fileFailure).parameter(0).toEqualTypeOf<ReadPcadFileErrorCode>();
  expectTypeOf<ReturnType<typeof parseFailure>>().toEqualTypeOf<Extract<ParseDocumentResult, { readonly ok: false }>>();
  expectTypeOf<ReturnType<typeof parseFailure>>().toEqualTypeOf<Extract<ReadAssemblyDocumentResult, { readonly ok: false }>>();
  expectTypeOf<ReturnType<typeof parseFailure>>().toEqualTypeOf<Extract<ParseDrawingResult, { readonly ok: false }>>();
  expectTypeOf<ReturnType<typeof fileFailure>>().toEqualTypeOf<Extract<ReadPcadFileResult, { readonly ok: false }>>();
  expectTypeOf<ReturnType<typeof fileFailure>>().toEqualTypeOf<Extract<ReadPcadaFileResult, { readonly ok: false }>>();
  expectTypeOf<ReturnType<typeof fileFailure>>().toEqualTypeOf<Extract<ReadPcaddFileResult, { readonly ok: false }>>();
  expect(fileFailure('notZip', 'not zip')).toStrictEqual({ ok: false, error: { code: 'notZip', message: 'not zip' } });
  expect(fileFailure('missingDocument', 'missing')).toStrictEqual({ ok: false, error: { code: 'missingDocument', message: 'missing' } });
});
