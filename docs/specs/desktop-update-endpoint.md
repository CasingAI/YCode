# Spec: Desktop 升级链路使用本机目标

## 目标

将 Desktop 的强制升级配置请求和自动更新 manifest 请求统一切换到升级专用的 `http://localhost`，不修改 ZCode 全局产品 endpoint，也暂不提供本地升级服务。

## 产品规则

- Desktop 升级链路的唯一默认目标 origin 是 `http://localhost`。
- 升级目标独立于 `DEFAULT_ZCODE_ENDPOINT_ORIGIN`、`zcodeEndpointOrigin`、`ZCODE_BASE_URL` 和其它产品 API 配置。
- 强制升级配置仍请求 `/api/v1/client/configs`，自动更新仍请求 `/api/v1/releases/electron/manifest`。
- 正式打包版本忽略 `ZCODE_UPDATE_FEED_URL` 和 `--zcode-update-feed-url`；这两个入口只保留给开发构建联调。
- 本机没有升级服务时，强制升级配置请求失败按现有 fail-open 语义放行；自动更新检查进入现有失败状态，不阻断普通启动和聊天。
- 本次不实现 localhost 上的配置服务、manifest 服务或安装包分发服务。

## 状态所有者与事件顺序

```text
Desktop update endpoint owner（固定 http://localhost）
  → force-update config request
  → startup gate
  → manifest request
  → update check / download state
```

- Desktop main 的升级 endpoint 常量是唯一目标事实源。
- force-update、manifest provider 和初始化装配都读取该 owner，不各自读取产品 endpoint。
- 请求失败不产生升级状态，不把产品 API 改道到 localhost。

## 接口与实现边界

- 新增 `packages/desktop/src/main/desktopUpdateEndpoint.ts`，提供升级专用 origin 常量和纯解析函数。
- `forceUpdateGuard.ts` 使用升级专用 origin 构造配置 URL和手动升级 URL。
- `manifestUpdateProvider.ts` 使用升级专用 origin 作为 manifest fallback。
- `autoUpdater.ts` 不再从 `resolveEndpointOrigin` 读取产品 endpoint；开发显式 feed override 仍按既有规则处理。
- `index.ts` 初始化升级和启动强更门禁时使用升级专用 owner，不把产品 endpoint resolver 传入升级链。
- `packages/shared/src/zcodeEndpoint.ts` 及其它产品 API endpoint 保持不变。

## 验收场景

1. 解析升级 endpoint 得到 `http://localhost`，且全局默认产品 endpoint 仍为 `https://zcode.z.ai`。
2. 升级配置 URL 为 `http://localhost/api/v1/client/configs`，manifest URL 为 `http://localhost/api/v1/releases/electron/manifest`，并保留平台、版本、渠道和设备参数。
3. localhost 没有服务时，Desktop 仍能创建主窗口；自动更新失败不阻断普通 session。
4. 显式修改 `zcodeEndpointOrigin` 不改变升级请求目标。
5. 定向测试、类型检查、Lint、架构检查和 diff 校验通过。

## 负面边界

- 不修改登录、Provider、Coding Plan、Remote Workspace、Desktop Context Prompt 或其它产品 API 的 endpoint。
- 不删除升级 UI、manifest 解析、下载器或失败处理。
- 不把开发环境 feed override 扩展到正式打包版本。
- 不清理或覆盖工作区其它未提交改动。
