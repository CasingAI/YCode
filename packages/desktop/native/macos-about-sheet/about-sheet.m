#import <AppKit/AppKit.h>

#define NAPI_VERSION 8
#include <node_api.h>
#include <string.h>

// Electron 的 hide() 对 macOS sheet 先 orderOut 再 endSheet，内容会瞬间消失。
// 这里只调用 AppKit 的 endSheet，让收场动画带着仍在绘制的窗口走。

static napi_value EndAttachedSheet(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_get_boolean(env, false, &result);

  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    return result;
  }

  bool isBuffer = false;
  napi_is_buffer(env, argv[0], &isBuffer);
  if (!isBuffer) {
    return result;
  }

  void* data = NULL;
  size_t length = 0;
  napi_get_buffer_info(env, argv[0], &data, &length);
  if (data == NULL || length < sizeof(void*)) {
    return result;
  }

  void* viewPtr = NULL;
  memcpy(&viewPtr, data, sizeof(void*));
  if (viewPtr == NULL) {
    return result;
  }

  NSView* view = (__bridge NSView*)viewPtr;
  NSWindow* window = view.window;
  NSWindow* parent = window.sheetParent;
  if (window == nil || parent == nil) {
    return result;
  }

  [parent endSheet:window];
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "endAttachedSheet", NAPI_AUTO_LENGTH, EndAttachedSheet, NULL, &fn);
  napi_set_named_property(env, exports, "endAttachedSheet", fn);
  return exports;
}

NAPI_MODULE(about_sheet, Init)
