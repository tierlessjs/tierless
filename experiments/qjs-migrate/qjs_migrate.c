// Migration-enabled QuickJS: a thin shim that runs JS in QuickJS-in-WASM and lets
// the host suspend it MID-SYNCHRONOUS-EXECUTION at a `db_query(...)` reference,
// snapshot linear memory, and resume in a fresh instance. The suspend is a raw
// asyncify unwind triggered from deep in QuickJS's C call stack; the unwound stack
// lives in a linear-memory buffer (qjs_dataptr), so a memory snapshot carries the
// whole suspended continuation.
#include "quickjs.h"
#include <emscripten.h>
#include <string.h>

extern int host_suspend(int query);   // JS import (ASYNCIFY_IMPORTS): unwind now, return the result on rewind

static JSRuntime *rt;
static JSContext *ctx;
static char g_code[16384];
static int g_final;

// db_query(n): a synchronous-looking host reference. Internally it SUSPENDS the
// whole QuickJS computation (asyncify unwind) so the host can migrate, then on
// resume returns the value the (possibly different) host supplied.
static JSValue js_db_query(JSContext *c, JSValueConst this_val, int argc, JSValueConst *argv) {
  int q = 0;
  if (argc > 0) JS_ToInt32(c, &q, argv[0]);
  int r = host_suspend(q);
  return JS_NewInt32(c, r);
}

EMSCRIPTEN_KEEPALIVE void qjs_init(void) {
  rt = JS_NewRuntime();
  ctx = JS_NewContext(rt);
  JSValue g = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, g, "db_query", JS_NewCFunction(ctx, js_db_query, "db_query", 1));
  JS_FreeValue(ctx, g);
}
EMSCRIPTEN_KEEPALIVE char *qjs_code_buf(void) { return g_code; }   // host writes the JS source here
EMSCRIPTEN_KEEPALIVE int qjs_eval(void) {
  JSValue v = JS_Eval(ctx, g_code, strlen(g_code), "<migrate>", JS_EVAL_TYPE_GLOBAL);
  // On unwind, asyncify returns here before touching v; the host detects suspension
  // via asyncify state. On normal completion / rewind-completion we land here for real.
  int n = -1;
  if (!JS_IsException(v)) JS_ToInt32(ctx, &n, v);
  JS_FreeValue(ctx, v);
  g_final = n;
  return 0;
}
EMSCRIPTEN_KEEPALIVE int qjs_final(void) { return g_final; }
