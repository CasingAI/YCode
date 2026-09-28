import assert from "node:assert/strict";
import test from "node:test";
import { writeTextToClipboard } from "../src/lib/clipboard.js";

// 复现用户现场：手机远控经 http 访问属于非安全上下文，navigator.clipboard 整个不存在；
// 另有内置 webview 虽暴露了 API 却以 NotAllowedError 拒绝写入。原实现两条路都静默
// ——前者直接 return，后者 re-throw 后没有 .catch()，用户看到的是「点了没反应」。

interface FakeElement {
  tagName: string;
  value: string;
  style: Record<string, string>;
  attributes: Record<string, string>;
  selected: boolean;
  selectionRange: [number, number] | null;
  appended: boolean;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  select(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
  focus(): void;
}

function createFakeElement(tagName: string): FakeElement {
  const element: FakeElement = {
    tagName,
    value: "",
    style: {},
    attributes: {},
    selected: false,
    selectionRange: null,
    appended: false,
    removed: false,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    select() {
      this.selected = true;
    },
    setSelectionRange(start, end) {
      this.selectionRange = [start, end];
    },
    remove() {
      this.removed = true;
      this.appended = false;
    },
    focus() {
      fakeDom.activeElement = this;
    },
  };
  // 真实浏览器里 HTMLElement 是全局类，helper 靠它判断能不能还焦点；
  // 假元素必须挂上同一个原型链，否则测到的不是浏览器里的那条分支。
  Object.setPrototypeOf(element, FakeHTMLElement.prototype);
  return element;
}

const fakeDom = {
  activeElement: null as FakeElement | null,
  execCommandResult: true,
  execCommandCalls: 0,
  execCommandThrows: false,
  body: null as FakeElement | null,
  createElement(tagName: string) {
    return createFakeElement(tagName);
  },
  execCommand(command: string) {
    if (command !== "copy") throw new Error(`unexpected command: ${command}`);
    this.execCommandCalls += 1;
    if (this.execCommandThrows) throw new Error("execCommand denied");
    return this.execCommandResult;
  },
};

class FakeHTMLElement {}

function withFakeDom<T>(run: () => Promise<T>): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");

  Object.defineProperty(globalThis, "HTMLElement", {
    value: FakeHTMLElement,
    configurable: true,
    writable: true,
  });

  fakeDom.body = createFakeElement("body");
  fakeDom.activeElement = null;
  fakeDom.execCommandCalls = 0;
  fakeDom.execCommandResult = true;
  fakeDom.execCommandThrows = false;

  const fakeDocument = {
    activeElement: null,
    body: {
      appendChild(child: FakeElement) {
        child.appended = true;
      },
    },
    createElement: (tagName: string) => fakeDom.createElement(tagName),
    execCommand: (command: string) => fakeDom.execCommand(command),
  };

  Object.defineProperty(globalThis, "document", {
    value: fakeDocument,
    configurable: true,
    writable: true,
  });
  return run().finally(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
    if (originalHTMLElement) {
      Object.defineProperty(globalThis, "HTMLElement", originalHTMLElement);
    } else {
      Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  });
}

function setNavigator(clipboard: unknown): void {
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard },
    configurable: true,
    writable: true,
  });
}

test("非安全上下文（navigator.clipboard 整个不存在）回退 execCommand 成功", async () => {
  await withFakeDom(async () => {
    setNavigator(undefined);
    await writeTextToClipboard("继续");
    assert.equal(fakeDom.execCommandCalls, 1);
  });
});

test("Clipboard API 存在但拒绝写入时，同样回退而不是把失败抛给用户", async () => {
  await withFakeDom(async () => {
    setNavigator({
      writeText: async () => {
        throw new DOMExceptionLike("NotAllowedError");
      },
    });
    await writeTextToClipboard("继续");
    assert.equal(fakeDom.execCommandCalls, 1);
  });
});

test("Clipboard API 成功时不再走 execCommand 兜底", async () => {
  await withFakeDom(async () => {
    let written: string | null = null;
    setNavigator({
      writeText: async (value: string) => {
        written = value;
      },
    });
    await writeTextToClipboard("继续");
    assert.equal(written, "继续");
    assert.equal(fakeDom.execCommandCalls, 0);
  });
});

test("两条路径都失败时抛错，让调用方有机会提示用户", async () => {
  await withFakeDom(async () => {
    setNavigator(undefined);
    fakeDom.execCommandResult = false;
    await assert.rejects(() => writeTextToClipboard("继续"), /clipboard-write-unavailable/);
  });
});

test("兜底 textarea 必须 readonly，否则触屏会弹出软键盘", async () => {
  await withFakeDom(async () => {
    setNavigator(undefined);
    const created: FakeElement[] = [];
    const fakeDocument = globalThis.document as unknown as {
      createElement: (tagName: string) => FakeElement;
    };
    const originalCreate = fakeDocument.createElement;
    fakeDocument.createElement = (tagName: string) => {
      const element = originalCreate(tagName);
      created.push(element);
      return element;
    };

    try {
      await writeTextToClipboard("继续");
    } finally {
      fakeDocument.createElement = originalCreate;
    }

    assert.equal(created.length, 1);
    const textarea = created[0];
    assert.equal(textarea.tagName, "textarea");
    assert.equal(textarea.attributes.readonly, "");
    assert.equal(textarea.value, "继续");
    // display:none 之类会让选区落空、execCommand 返回 false。
    assert.equal(textarea.style.display, undefined);
    assert.equal(textarea.style.opacity, "0");
    assert.deepEqual(textarea.selectionRange, [0, "继续".length]);
  });
});

test("兜底结束后把焦点还给原元素，不打断正在输入的输入框", async () => {
  await withFakeDom(async () => {
    setNavigator(undefined);
    const previous = createFakeElement("div");
    const fakeDocument = globalThis.document as unknown as { activeElement: FakeElement | null };
    fakeDocument.activeElement = previous;

    await writeTextToClipboard("继续");
    assert.equal(fakeDom.activeElement, previous);
  });
});

class DOMExceptionLike extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}
