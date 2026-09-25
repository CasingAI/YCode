# Web Lite Token 浏览器认证

## 目标

让通过 `?token=<token>` 首次验证的浏览器，在不保存 Web OAuth 登录态、不把 token 暴露给页面脚本的前提下，跨浏览器会话长期保持对同一个受保护 Web Host 的访问能力。关闭并重新打开浏览器后，访问同一 origin 不再要求重新使用 token 链接。

本规格适用于所有通过 `createLanHttpServer` 启用的 lite-token 服务，包括桌面 Mobile Remote Control，以及 `zcode --web` 在当前服务进程和 token 生命周期内提供的 Web 入口。

## 产品规则

- 首次通过非升级 HTTP 请求（通常是 `GET /?token=...`）携带正确 `?token=<token>` 时，服务端验证 token 并设置 `zcode_lite_token` Cookie；后续 `/api/*` 与 `/ws*` 可以只凭该 Cookie 鉴权。直接以 `?token=` 发起 `/ws*` 升级不作为 Cookie 交换入口，应先完成页面请求。
- Cookie 使用 `Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`，首次成功交换后一年内有效；再次通过带 token 的链接访问时会刷新这一期限。“长期有效”表示跨浏览器会话保存，不表示永久有效。
- Cookie 是服务端当前 token 的客户端副本，不是新的认证事实来源。服务端当前配置的 token 仍是唯一权威；不把 token 写入 `localStorage`、`sessionStorage`、IndexedDB 或页面可读状态。
- Cookie 缺失、过期、host 不匹配、值不匹配或服务端已轮换 token 时，`/api/*` 与 `/ws*` 一律返回 401；静态首页仍可匿名加载。Cookie 按浏览器规则以 host 为作用域，不按端口隔离。
- 服务端轮换 token 后，旧 query token 和旧 Cookie 立即失效；用户必须打开新链接重新交换 Cookie。若轮换与启动并发，先等待在途启动收尾，再以新 token 重建，避免旧启动把旧 token 写回。同一 runtime 的并发 `resetToken()` 共享同一次轮换结果，不能交叉重建出不同 token。持久化不能绕过撤销边界。
- 当前局域网入口使用 HTTP，因此不设置 `Secure`。HTTPS 部署与反向代理下的 Cookie 属性属于独立变更，不在本规格内。
- Cookie 持久化只恢复认证，不恢复已经关闭的页面、WebSocket attachment、内存草稿或挂起 RPC。重新打开页面仍按现有生命周期创建新的 WebSocket attachment。
- `createLanHttpServer().close()` 必须先终止已升级的 WebSocket，再等待 HTTP server 关闭完成；否则远控 `stop()` 或 `resetToken()` 可能被活动连接永久阻塞。
- Web 分享页 OAuth、`packages/web/src/auth/*` 的浏览器登录仓储、服务端 `credentials.json` 和 provider refresh token 是另一套认证链路，本规格不修改。

## 状态所有者与事件顺序

服务端 HTTP 鉴权中间件是 Cookie 写入和校验的唯一所有者；浏览器只保存服务端颁发的凭据，不参与 token 生成、轮换或撤销。

```text
首次 GET /?token=...
  → 中间件校验 query token
  → 设置一年期 HttpOnly Cookie
  → 后续请求自动携带 Cookie
  → 中间件用当前服务端 token 校验
  → 放行 /api/* 与 /ws*

reset token
  → 服务端当前 token 改变
  → 旧 query token / 旧 Cookie 均返回 401
  → 新链接设置新 Cookie
```

## 接口

- 共享实现：`packages/server/src/http.ts` 的 `hasValidLiteToken()` 与 `createLanHttpServer()`。
- Cookie 名称：`zcode_lite_token`。
- 默认期限：31,536,000 秒（365 天），由 HTTP 鉴权模块中的命名常量统一管理。
- 桌面远控 token 的生成、持久化和轮换仍由 `IMobileRemoteControlService` / `MobileRemoteControlRuntime` 负责；共享 HTTP 层不反向管理桌面状态。
- `zcode --web` 的 token 仍由 runner 在进程启动时提供；本规格不增加 standalone 跨进程 token 落盘。

## 负面边界

- 不把 lite token 迁移到 OAuth，也不修改 Web 分享页登录和退出。
- 不新增服务端 session、设备注册表、refresh token、逐设备撤销或后台 attachment 恢复。
- 不修改 WebSocket managed reconnect 的退避和 service generation 规则。
- 不修改 `resetToken()` 的同端口重建语义。
- 不承诺浏览器清除站点数据、使用新 origin 或超过一年后仍可免链接访问。
- 不为 `zcode --web` 复用桌面 `mobile-remote-control.json`；两者是不同生命周期和凭据域。

## 验收场景

1. 新浏览器访问 `/?token=<token>` → 响应设置包含 `Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax` 的 `zcode_lite_token` Cookie。
2. 只携带该 Cookie 访问 `/api/server-info` → 200；携带同一 Cookie 完成 `/ws` 握手 → 101；请求 URL 不再需要 query token。
3. 无 Cookie、错误 Cookie、错误 query token → `/api/*` 与 `/ws*` 返回 401，静态首页仍可加载。
4. 服务端轮换 token → 旧 Cookie 与旧链接立即 401；打开新链接后新 Cookie 生效。
5. 首次验证后关闭全部浏览器窗口，再访问同一 origin 的 `/` → 不重新使用 token 链接也能完成 API bootstrap 和 WebSocket 建连。
6. 清除站点数据、Cookie 过期或换用不同 origin → 重新打开受保护入口时显示现有 bootstrap error，不静默绕过鉴权。
7. 存在已鉴权 WebSocket 时调用 `close()` → 升级连接被终止，`close()` 在有界时间内完成；远控随后可以正常 `stop()` 或 `resetToken()`。
8. `resetToken()` 与启动中的 `start()` 并发 → 轮换等待旧启动收尾后用新 token 重建；旧启动不会把旧 token 或旧 listener 写回。
9. 同一 runtime 同时调用两次 `resetToken()` → 两次调用共享同一个轮换结果，监听与落盘 token 保持一致。
