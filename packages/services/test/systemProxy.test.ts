import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMacOsScutilProxyOutput,
  parseWindowsProxyRegOutput,
} from "../src/runtime-tools/systemProxy.js";

// 「系统代理设置」按模型代理模式的材料解析（docs/specs/network-settings.md）：
// darwin scutil --proxy、win32 reg query。纯函数锁定解析规则，实际 execFile 由
// resolveSystemProxySettings 按平台分支执行，失败兜底 undefined 不阻断 spawn。

test("scutil：HTTPS 启用时优先于 HTTP，ExceptionsList 拼为 noProxy", () => {
  const output = [
    "<dictionary> {",
    "  HTTPEnable : 1",
    "  HTTPPort : 7890",
    "  HTTPProxy : 10.0.0.2",
    "  HTTPSEnable : 1",
    "  HTTPSPort : 7891",
    "  HTTPSProxy : 10.0.0.3",
    "  SOCKSEnable : 0",
    "  ExceptionsList : <array> {",
    "    0 : 127.0.0.1",
    "    1 : localhost",
    "    2 : 192.168.0.0/16",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(parseMacOsScutilProxyOutput(output), {
    httpProxy: "http://10.0.0.3:7891",
    noProxy: "127.0.0.1,localhost,192.168.0.0/16",
  });
});

test("scutil：仅 HTTP 启用时走 HTTP；仅 SOCKS 启用时输出 socks5://", () => {
  const httpOnly = parseMacOsScutilProxyOutput(
    [
      "  HTTPEnable : 1",
      "  HTTPPort : 7890",
      "  HTTPProxy : 127.0.0.1",
      "  HTTPSEnable : 0",
      "  SOCKSEnable : 0",
    ].join("\n"),
  );
  assert.deepEqual(httpOnly, { httpProxy: "http://127.0.0.1:7890" });

  const socksOnly = parseMacOsScutilProxyOutput(
    [
      "  HTTPEnable : 0",
      "  HTTPSEnable : 0",
      "  SOCKSEnable : 1",
      "  SOCKSPort : 1080",
      "  SOCKSProxy : 127.0.0.1",
    ].join("\n"),
  );
  assert.deepEqual(socksOnly, { httpProxy: "socks5://127.0.0.1:1080" });
});

test("scutil：全部未启用或端口非法时返回 undefined", () => {
  const disabled = parseMacOsScutilProxyOutput(
    ["  HTTPEnable : 0", "  HTTPSEnable : 0", "  SOCKSEnable : 0"].join("\n"),
  );
  assert.equal(disabled, undefined);
  const badPort = parseMacOsScutilProxyOutput(
    ["  HTTPEnable : 1", "  HTTPPort : 0", "  HTTPProxy : 127.0.0.1"].join("\n"),
  );
  assert.equal(badPort, undefined);
  assert.equal(parseMacOsScutilProxyOutput(""), undefined);
});

test("reg：ProxyEnable=1 且简式 ProxyServer 输出 http:// 地址，ProxyOverride 拼为 noProxy", () => {
  const output = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    "    ProxyEnable    REG_DWORD    0x1",
    "    ProxyServer    REG_SZ    127.0.0.1:7890",
    "    ProxyOverride    REG_SZ    localhost;127.*;<local>",
  ].join("\n");
  assert.deepEqual(parseWindowsProxyRegOutput(output), {
    httpProxy: "http://127.0.0.1:7890",
    noProxy: "localhost,127.*,<local>",
  });
});

test("reg：协议式 ProxyServer 取 https 分量，缺 https 回退 http", () => {
  const withHttps = parseWindowsProxyRegOutput(
    ["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    http=10.0.0.1:8080;https=10.0.0.2:8443"].join(
      "\n",
    ),
  );
  assert.deepEqual(withHttps, { httpProxy: "http://10.0.0.2:8443" });
  const httpFallback = parseWindowsProxyRegOutput(
    ["    ProxyEnable    REG_DWORD    0x1", "    ProxyServer    REG_SZ    http=10.0.0.1:8080;ftp=10.0.0.3:21"].join(
      "\n",
    ),
  );
  assert.deepEqual(httpFallback, { httpProxy: "http://10.0.0.1:8080" });
});

test("reg：未启用（ProxyEnable=0x0）或缺 ProxyServer 时返回 undefined", () => {
  const disabled = parseWindowsProxyRegOutput(
    ["    ProxyEnable    REG_DWORD    0x0", "    ProxyServer    REG_SZ    127.0.0.1:7890"].join("\n"),
  );
  assert.equal(disabled, undefined);
  const emptyServer = parseWindowsProxyRegOutput(["    ProxyEnable    REG_DWORD    0x1"].join("\n"));
  assert.equal(emptyServer, undefined);
});
