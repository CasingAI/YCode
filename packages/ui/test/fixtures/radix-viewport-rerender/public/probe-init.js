/*
 * 独立浏览器夹具的测量探针。
 *
 * 必须在 React/Radix 模块执行前加载，只记录事实，不改变业务语义：
 * - style.innerHTML 写入：区分首次写入、实际重挂载后的首次写入与已存在节点的重复写入；
 * - DocumentFragment 构造次数：Radix Select 关闭时把内容 portal 进 detached fragment；
 * - data-frame 属性提交：证明每次强制重渲染都确实到达 Viewport 节点（fragment 内也能看到）。
 */
(function installProbe() {
  "use strict";

  var state = {
    phase: "boot",
    records: [],
    frameCommits: [],
    fragments: 0,
    fragmentProbe: false,
    innerHtmlProbe: false,
    frameProbe: false,
  };
  window.__radixProbe = state;

  state.reset = function reset(phase) {
    state.phase = phase === undefined ? state.phase : phase;
    state.records.length = 0;
    state.frameCommits.length = 0;
  };

  try {
    var NativeFragment = window.DocumentFragment;
    var FragmentProxy = new Proxy(NativeFragment, {
      construct: function construct(target, args) {
        state.fragments += 1;
        return Reflect.construct(target, args, target);
      },
    });
    Object.defineProperty(window, "DocumentFragment", {
      configurable: true,
      writable: true,
      value: FragmentProxy,
    });
    state.fragmentProbe = true;
  } catch (error) {
    state.fragmentProbeError = String(error);
  }

  try {
    var descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (descriptor && descriptor.set && descriptor.get) {
      var styleIds = new WeakMap();
      var seenStyles = new WeakSet();
      var nextStyleId = 1;

      Object.defineProperty(Element.prototype, "innerHTML", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function get() {
          return descriptor.get.call(this);
        },
        set: function set(value) {
          if (this.tagName === "STYLE") {
            var id = styleIds.get(this);
            if (id === undefined) {
              id = nextStyleId++;
              styleIds.set(this, id);
            }
            var first = !seenStyles.has(this);
            seenStyles.add(this);
            state.records.push({
              id: id,
              first: first,
              phase: state.phase,
              connected: this.isConnected,
              html: String(value),
              nonce: this.getAttribute("nonce"),
            });
          }
          return descriptor.set.call(this, value);
        },
      });
      state.innerHtmlProbe = true;
    }
  } catch (error) {
    state.innerHtmlProbeError = String(error);
  }

  try {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (name === "data-frame") {
        var kind = this.hasAttribute("data-radix-select-viewport")
          ? "select"
          : this.hasAttribute("data-radix-scroll-area-viewport")
            ? "scroll"
            : null;
        if (kind) {
          state.frameCommits.push({
            kind: kind,
            phase: state.phase,
            connected: this.isConnected,
            value: String(value),
          });
        }
      }
      return nativeSetAttribute.call(this, name, value);
    };
    state.frameProbe = true;
  } catch (error) {
    state.frameProbeError = String(error);
  }
})();
