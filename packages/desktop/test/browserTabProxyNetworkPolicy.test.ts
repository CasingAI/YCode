import assert from "node:assert/strict";
import test from "node:test";
import type { ProxyConfig, Session } from "electron";
import { applyDesktopChromiumNetworkPolicies } from "../src/main/desktopNetworkPolicy.js";
import {
  EMBEDDED_BROWSER_PARTITION,
  EMBEDDED_BROWSER_PROXY_PARTITION,
} from "../src/main/browserDataManager.js";

// 代理标签页出口策略（docs/specs/browser-tab-proxy.md）：第三个 Chromium target
// （persist:zcode-embedded-browser-proxy）只看 embeddedBrowserProxy，不受 httpProxyEnabled gate。

interface RecordedSession {
  session: Session;
  proxyCalls: ProxyConfig[];
  verifyProcCalls: Array<((request: unknown, callback: (result: number) => void) => void) | null>;
}

function createFakeSession(): RecordedSession {
  const recorded: RecordedSession = {
    session: {
      setProxy: async (config: ProxyConfig) => {
        recorded.proxyCalls.push(config);
      },
      closeAllConnections: async () => {},
      setCertificateVerifyProc: (proc) => {
        recorded.verifyProcCalls.push(proc);
      },
    } as unknown as Session,
    proxyCalls: [],
    verifyProcCalls: [],
  };
  return recorded;
}

function createProvider() {
  const defaultRecord = createFakeSession();
  const partitions = new Map<string, RecordedSession>();
  const provider = {
    defaultSession: defaultRecord.session,
    fromPartition(partition: string): Session {
      let record = partitions.get(partition);
      if (!record) {
        record = createFakeSession();
        partitions.set(partition, record);
      }
      return record.session;
    },
  };
  const logger = { info: () => {}, warn: () => {} };
  return {
    provider,
    defaultRecord,
    browserRecord: () => {
      const record = partitions.get(EMBEDDED_BROWSER_PARTITION);
      assert.ok(record, "内置浏览器分区未建立 session");
      return record;
    },
    proxyBrowserRecord: () => {
      const record = partitions.get(EMBEDDED_BROWSER_PROXY_PARTITION);
      assert.ok(record, "代理分区未建立 session");
      return record;
    },
    apply: (settings: Parameters<typeof applyDesktopChromiumNetworkPolicies>[1]) =>
      applyDesktopChromiumNetworkPolicies(provider, settings, logger),
  };
}

test("代理分区已配置地址时出口为 fixed_servers + <local> bypass", async () => {
  const harness = createProvider();
  await harness.apply({
    embeddedBrowserProxy: "127.0.0.1:7890",
    embeddedBrowserAllowInsecureCertificates: false,
  });
  assert.deepEqual(harness.proxyBrowserRecord().proxyCalls, [
    { mode: "fixed_servers", proxyRules: "http://127.0.0.1:7890", proxyBypassRules: "<local>" },
  ]);
});

test("代理分区未配置地址时 direct 兜底，不误连系统代理", async () => {
  const harness = createProvider();
  await harness.apply({ embeddedBrowserAllowInsecureCertificates: false });
  assert.deepEqual(harness.proxyBrowserRecord().proxyCalls, [{ mode: "direct" }]);
});

test("代理分区不受 httpProxyEnabled gate：全局开代理但标签页地址留空仍直连", async () => {
  const harness = createProvider();
  await harness.apply({
    httpProxyEnabled: true,
    httpProxy: "10.0.0.2:7890",
    embeddedBrowserAllowInsecureCertificates: false,
  });
  assert.deepEqual(harness.proxyBrowserRecord().proxyCalls, [{ mode: "direct" }]);
  // 默认 session 仍按全局 gate 推导，两个出口互不掺和。
  assert.deepEqual(harness.defaultRecord.proxyCalls, [{ mode: "fixed_servers", proxyRules: "http://10.0.0.2:7890" }]);
});

test("证书策略覆盖两个浏览器分区，defaultSession 收到 null 恢复默认校验", async () => {
  const harness = createProvider();
  await harness.apply({
    embeddedBrowserAllowInsecureCertificates: true,
    embeddedBrowserProxy: "127.0.0.1:7890",
  });
  assert.equal(harness.proxyBrowserRecord().verifyProcCalls.length, 1);
  assert.notEqual(harness.proxyBrowserRecord().verifyProcCalls[0], null);
  assert.equal(harness.browserRecord().verifyProcCalls.length, 1);
  assert.notEqual(harness.browserRecord().verifyProcCalls[0], null);
  // defaultSession 传 null 等于恢复 Chromium 默认校验，并未放行证书错误。
  assert.deepEqual(harness.defaultRecord.verifyProcCalls, [null]);
});

test("普通内置浏览器分区留空时跟随系统，与代理分区的 direct 兜底相区分", async () => {
  const harness = createProvider();
  await harness.apply({ embeddedBrowserAllowInsecureCertificates: false });
  assert.deepEqual(harness.browserRecord().proxyCalls, [{ mode: "system" }]);
});
