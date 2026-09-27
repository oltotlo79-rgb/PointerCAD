/* PointerCAD's original bridge to the documented QuickJS-ng C API.
 * No quickjs-wasi source, exports or host wrapper is used by this interface.
 * One module instance owns one runtime. Host values are bounded opaque handles;
 * no host object, filesystem, socket or process is exposed to guest JavaScript. */
#include "quickjs.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT(name) __attribute__((export_name("pcad_" #name)))
#define IMPORT(name) __attribute__((import_module("pointercad"), import_name(#name)))
#define HANDLE_CAPACITY 4096
#define ARGUMENT_CAPACITY 64
IMPORT(interrupt) extern int host_interrupt(void);
IMPORT(call) extern int host_call(int callback, int count, const uint32_t *args);
IMPORT(rejection) extern void host_rejection(uint32_t identity, int reason, int handled);
IMPORT(normalize) extern char *host_normalize(const char *base, const char *requested);
IMPORT(load) extern char *host_load(const char *name);

static JSRuntime *runtime;
static JSContext *context;
static JSValue handles[HANDLE_CAPACITY];
static unsigned char occupied[HANDLE_CAPACITY];
static int fatal;

static JSValue value(int handle) {
    if (handle > 0 && handle < HANDLE_CAPACITY && occupied[handle]) return handles[handle];
    fatal = 1;
    return JS_UNDEFINED;
}
/* Takes ownership, including primitive values. A negative handle is an exception. */
static int keep(JSValue input) {
    int exception = JS_IsException(input);
    if (exception) input = JS_GetException(context);
    for (int index = 1; index < HANDLE_CAPACITY; index++) {
        if (occupied[index]) continue;
        occupied[index] = 1;
        handles[index] = input;
        return exception ? -index : index;
    }
    JS_FreeValue(context, input);
    fatal = 1;
    return 0;
}
EXPORT(release) void pcad_release(int handle) {
    if (handle <= 0 || handle >= HANDLE_CAPACITY || !occupied[handle]) { fatal = 1; return; }
    JS_FreeValue(context, handles[handle]);
    handles[handle] = JS_UNDEFINED;
    occupied[handle] = 0;
}
static int interrupt(JSRuntime *rt, void *opaque) { return fatal || host_interrupt(); }
static void rejection(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool handled, void *opaque) {
    int handle = keep(JS_DupValue(ctx, reason));
    if (handle <= 0) return;
    host_rejection((uint32_t)(uintptr_t)JS_VALUE_GET_PTR(promise), handle, handled);
    pcad_release(handle);
}
static char *normalize(JSContext *ctx, const char *base, const char *requested, void *opaque) {
    char *source = host_normalize(base, requested);
    if (!source) { JS_ThrowTypeError(ctx, "Module denied"); return NULL; }
    char *name = js_strdup(ctx, source);
    free(source);
    return name;
}
static JSModuleDef *load(JSContext *ctx, const char *name, void *opaque) {
    char *source = host_load(name);
    if (!source) { JS_ThrowTypeError(ctx, "Module denied"); return NULL; }
    JSValue compiled = JS_Eval(ctx, source, strlen(source), name, JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
    free(source);
    if (JS_IsException(compiled)) return NULL;
    JSModuleDef *module = JS_VALUE_GET_PTR(compiled);
    JS_FreeValue(ctx, compiled);
    return module;
}
static JSValue call(JSContext *ctx, JSValueConst this_value, int count, JSValueConst *args, int magic) {
    if (count > ARGUMENT_CAPACITY) return JS_ThrowTypeError(ctx, "Too many host arguments");
    uint32_t ids[ARGUMENT_CAPACITY];
    int allocated = 0;
    for (; allocated < count; allocated++) {
        int id = keep(JS_DupValue(ctx, args[allocated]));
        if (id <= 0) break;
        ids[allocated] = (uint32_t)id;
    }
    int returned = allocated == count ? host_call(magic, count, ids) : 0;
    JSValue result = returned > 0 ? JS_DupValue(ctx, value(returned)) : JS_EXCEPTION;
    for (int index = 0; index < allocated; index++) pcad_release((int)ids[index]);
    if (returned <= 0) return JS_ThrowInternalError(ctx, "Host boundary failed");
    return result;
}

EXPORT(abi) int pcad_abi(void) { return 1; }
EXPORT(init) int pcad_init(uint32_t memory_limit, uint32_t stack_limit) {
    if (runtime) return 0;
    runtime = JS_NewRuntime();
    if (!runtime) return 0;
    JS_SetMemoryLimit(runtime, memory_limit);
    JS_SetMaxStackSize(runtime, stack_limit);
    JS_SetInterruptHandler(runtime, interrupt, NULL);
    JS_SetCanBlock(runtime, false);
    JS_SetHostPromiseRejectionTracker(runtime, rejection, NULL);
    JS_SetModuleLoaderFunc(runtime, normalize, load, NULL);
    context = JS_NewContext(runtime);
    return context != NULL;
}
EXPORT(close) void pcad_close(void) {
    if (context) {
        for (int index = 1; index < HANDLE_CAPACITY; index++) if (occupied[index]) pcad_release(index);
        JS_FreeContext(context); context = NULL;
    }
    if (runtime) { JS_FreeRuntime(runtime); runtime = NULL; }
}
EXPORT(global) int pcad_global(void) { return keep(JS_GetGlobalObject(context)); }
EXPORT(constant) int pcad_constant(int kind) { return keep(kind == 1 ? JS_TRUE : kind == 2 ? JS_FALSE : JS_UNDEFINED); }
EXPORT(number) int pcad_number(double number) { return keep(JS_NewFloat64(context, number)); }
EXPORT(string) int pcad_string(const char *text, uint32_t length) { return keep(JS_NewStringLen(context, text, length)); }
EXPORT(dup) int pcad_dup(int handle) { return keep(JS_DupValue(context, value(handle))); }
EXPORT(is_string) int pcad_is_string(int handle) { return JS_IsString(value(handle)); }
EXPORT(is_error) int pcad_is_error(int handle) { return JS_IsError(value(handle)); }
/* A host read is permitted only for a primitive string; never run guest coercion. */
EXPORT(string_data) const char *pcad_string_data(int handle, uint32_t *length) {
    if (!JS_IsString(value(handle))) return NULL;
    size_t size = 0;
    const char *text = JS_ToCStringLen(context, &size, value(handle));
    *length = (uint32_t)size;
    return text;
}
EXPORT(string_free) void pcad_string_free(const char *text) { JS_FreeCString(context, text); }
EXPORT(function) int pcad_function(const char *name, int callback) {
    return keep(JS_NewCFunctionMagic(context, call, name, 0, JS_CFUNC_generic_magic, callback));
}
EXPORT(set) int pcad_set(int target, const char *name, int source) {
    JS_UpdateStackTop(runtime);
    int status = JS_SetPropertyStr(context, value(target), name, JS_DupValue(context, value(source)));
    return status < 0 ? keep(JS_EXCEPTION) : keep(JS_UNDEFINED);
}
EXPORT(eval) int pcad_eval(const char *source, uint32_t length, const char *name, int module) {
    JS_UpdateStackTop(runtime);
    return keep(JS_Eval(context, source, length, name, module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL));
}
EXPORT(call) int pcad_call(int function, int receiver, int count, const uint32_t *args) {
    if (count < 0 || count > ARGUMENT_CAPACITY) return 0;
    JSValue values[ARGUMENT_CAPACITY];
    for (int index = 0; index < count; index++) values[index] = value((int)args[index]);
    JS_UpdateStackTop(runtime);
    return keep(JS_Call(context, value(function), value(receiver), count, values));
}
EXPORT(job) int pcad_job(void) {
    JSContext *job_context;
    JS_UpdateStackTop(runtime);
    int status = JS_ExecutePendingJob(runtime, &job_context);
    return status < 0 ? keep(JS_EXCEPTION) : status;
}
EXPORT(promise_state) int pcad_promise_state(int handle) { return JS_PromiseState(context, value(handle)); }
EXPORT(promise_result) int pcad_promise_result(int handle) { return keep(JS_PromiseResult(context, value(handle))); }
EXPORT(promise_handled) void pcad_promise_handled(int handle) { JS_PromiseMarkAsHandled(context, value(handle)); }

/* WASI libc supplies UTC calendar conversion without host timezone access. */
void __wrap___secs_to_zone(long long t, int local, int *isdst, long *offset, long *opposite, const char **name) {
    *isdst = 0; *offset = 0; *opposite = 0; *name = "UTC";
}
