import assert from "node:assert/strict";
import test from "node:test";
import { createConfig } from "../src/config/index.js";
import { parseEnvConfig } from "../src/config/env-config.adapter.js";
import { ZCodeConfigFileSchema } from "../src/config/schema.js";
import { resolveMcpNetwork } from "../src/mcp/network.js";

// 回归测试：按服务器代理的原始材料必须活过整条配置管线。
//
// 曾经的真实故障：Host 只在 agent env 注入 ZCODE_APP_HTTP_PROXY，parseEnvConfig 也正确解析出
// config.network.appHttpProxy，但 createConfigPort() 的搬运与 getAll() 都只枚举了 4 个老字段，
// zod 的 networkSchema 也只声明了这 4 个（默认 strip 未声明键）。地址在到达 MCP 之前被静默
// 丢弃，resolveMcpNetwork("proxy") 读不到任何地址，只能降级成直连——用户选了「使用代理」，
// 服务器却连不上，报错还显示「网络不可达」。链路里任何一环漏字段都会复现这个故障，
// 因此这里逐层钉住，而不是只测最后一层。

const APP_PROXY = "http://localhost:7890";
const APP_NO_PROXY = "127.0.0.1";

test("env 层：ZCODE_APP_*/ZCODE_SYSTEM_* 解析出独立的 network 字段", () => {
  const patch = parseEnvConfig({
    ZCODE_APP_HTTP_PROXY: APP_PROXY,
    ZCODE_APP_NO_PROXY: APP_NO_PROXY,
    ZCODE_SYSTEM_HTTP_PROXY: "http://system-proxy:8888",
    ZCODE_SYSTEM_NO_PROXY: "example.com",
  } as NodeJS.ProcessEnv);

  assert.equal(patch.network?.appHttpProxy, APP_PROXY);
  assert.equal(patch.network?.appNoProxy, APP_NO_PROXY);
  assert.equal(patch.network?.systemHttpProxy, "http://system-proxy:8888");
  assert.equal(patch.network?.systemNoProxy, "example.com");
});

test("schema 层：配置文件里的 app*/system* 材料不被 zod strip 掉", () => {
  const parsed = ZCodeConfigFileSchema.parse({
    network: {
      appHttpProxy: APP_PROXY,
      appNoProxy: APP_NO_PROXY,
      systemHttpProxy: "http://system-proxy:8888",
      systemNoProxy: "example.com",
    },
  });

  assert.equal(parsed.network?.appHttpProxy, APP_PROXY);
  assert.equal(parsed.network?.appNoProxy, APP_NO_PROXY);
  assert.equal(parsed.network?.systemHttpProxy, "http://system-proxy:8888");
  assert.equal(parsed.network?.systemNoProxy, "example.com");
});

test("管线层：createConfig 的返回值仍带着 agent env 注入的代理地址", async () => {
  // 不指定 userConfigPath：只验证 env → createConfigPort → getAll() 这一段，
  // 避免用例依赖开发者本机的 ~/.zcode/cli/config.json 内容。
  const result = await createConfig({
    env: {
      ZCODE_APP_HTTP_PROXY: APP_PROXY,
      ZCODE_APP_NO_PROXY: APP_NO_PROXY,
    } as NodeJS.ProcessEnv,
    skipUserConfig: true,
  });

  assert.equal(result.config.network.appHttpProxy, APP_PROXY);
  assert.equal(result.config.network.appNoProxy, APP_NO_PROXY);
});

test("端到端：env 注入的地址能真正决定 MCP server 的 proxyMode=proxy 出口", async () => {
  const result = await createConfig({
    env: {
      ZCODE_APP_HTTP_PROXY: APP_PROXY,
      ZCODE_APP_NO_PROXY: APP_NO_PROXY,
    } as NodeJS.ProcessEnv,
    skipUserConfig: true,
  });

  // 这条断言是本次故障的直接判据：地址若在中途被丢，proxy 模式就会退化成
  // ignoreProxyEnv + missingProxyAddress，MCP 会直连并最终以 probe 超时收场。
  assert.deepEqual(resolveMcpNetwork("proxy", result.config.network), {
    httpProxy: APP_PROXY,
    noProxy: APP_NO_PROXY,
  });
});
