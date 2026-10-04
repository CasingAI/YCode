import { Link } from "../router.js";

type FeatureCard = {
  title: string;
  description: string;
  to: string;
};

const FEATURES: FeatureCard[] = [
  {
    title: "官方 Provider 与额度",
    description:
      "智谱 Z.AI / BigModel 与 OpenCode 官方支持：账号登录、Coding Plan、套餐额度与重置倒计时直接显示在应用里；DeepSeek 的账户余额同样直接可见。",
    to: "/docs/zhipu",
  },
  {
    title: "Web 与手机远控",
    description:
      "桌面端一键开启局域网访问，手机浏览器直连同一个 Host、同一个会话，固定端口与令牌鉴权，不依赖外部中转。",
    to: "/docs/remote",
  },
  {
    title: "目标模式",
    description:
      "用 /goal 下达一个持久目标，运行时进入自主循环，持续朝目标工作，直到完成审计收口。",
    to: "/docs/goal",
  },
  {
    title: "计划模式",
    description:
      "先探索与计划、批准再执行；每份计划自动落盘为工作区文件，压缩后仍可经 ListPlans 取回。",
    to: "/docs/plan",
  },
  {
    title: "子代理",
    description: "前台执行、持久身份、可跨重启续跑；并发批次统一收束，身份与运行状态各归其主。",
    to: "/docs/subagents",
  },
  {
    title: "动态工作流",
    description: "用 TypeScript 脚本编排多个模型子代理：循环、条件、并行扇出，中间结果有类型。",
    to: "/docs/workflows",
  },
  {
    title: "自动化与闲时任务",
    description: "按 cron 或延迟计划重复运行任务；可推迟的工作丢进空闲算力队列，闲时执行不计费。",
    to: "/docs/automations",
  },
  {
    title: "扩展生态",
    description:
      "技能、自定义命令、Hooks、MCP 与插件五类资源，用户与工作区两级作用域，团队可共享、可版本化。",
    to: "/docs/plugins",
  },
  {
    title: "网络与代理",
    description: "全局代理总开关、自定义证书，并为每个模型、每个 MCP 服务器单独选择出口策略。",
    to: "/docs/network",
  },
];

const PRINCIPLES: { name: string; text: string }[] = [
  {
    name: "贴近官方原版",
    text: "默认体验与 ZCode 官方保持一致，不做破坏性改造，便于随时与上游对比、同步官方更新。",
  },
  { name: "多供应商协作", text: "把只有官方供应商享受的能力推广到每一个你实际在用的供应商。" },
  { name: "开发优先", text: "功能设计以写代码为中心，优先解决真实编码流程中的阻塞点。" },
  {
    name: "细节更顺手",
    text: "用一批小功能优化、遗留问题修复与性能优化，让日常体验优于官方版本。",
  },
  {
    name: "开源自主",
    text: "完整构建流程与运行时开源，可自行构建、审计与修改，代码与数据留在自己的环境中。",
  },
];

const CLIENTS: { name: string; text: string }[] = [
  { name: "桌面端", text: "Electron 应用：窗口、原生操作与 Host 进程调度，本地工作区的默认入口。" },
  {
    name: "Web 端",
    text: "浏览器访问同一套服务；手机浏览器经局域网远控桌面，复用正在运行的会话。",
  },
  {
    name: "Agent CLI",
    text: "终端里的 Agent 运行时，零生产依赖的 Node CLI，也是桌面端的 Agent 内核。",
  },
];

function SectionTitle({ children }: { children: string }) {
  return <h2 className="mb-8 text-center text-2xl font-bold tracking-tight">{children}</h2>;
}

export function Home() {
  return (
    <div>
      <section className="border-b border-[color:var(--site-border)]">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 md:grid-cols-2 md:py-24">
          <div>
            <span className="inline-block rounded-full border border-[color:var(--site-border)] bg-[color:var(--site-bg-soft)] px-3 py-1 text-xs text-[color:var(--site-fg-subtle)]">
              ZCode 社区分支 · Apache-2.0 开源
            </span>
            <h1 className="mt-5 text-4xl font-bold tracking-tight md:text-5xl">
              自托管的
              <br />
              AI 编程工作台
            </h1>
            <p className="mt-5 text-[15px] leading-relaxed text-[color:var(--site-fg-subtle)]">
              YCode 是 ZCode 的社区分支。桌面版、Web 版与终端 Agent
              全部在仓库中开源：代码、构建流程、会话数据都在你自己的机器上，模型请求发往你配置的供应商端点。
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                className="rounded-lg bg-[color:var(--site-brand)] px-5 py-2.5 text-sm font-medium text-white hover:opacity-90"
                to="/docs/install"
              >
                快速开始
              </Link>
              <Link
                className="rounded-lg border border-[color:var(--site-border)] px-5 py-2.5 text-sm font-medium hover:bg-[color:var(--site-bg-soft)]"
                to="/docs/welcome"
              >
                了解 YCode
              </Link>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-[color:var(--site-border)] bg-[color:var(--site-pre-bg)] p-5 text-[13px] leading-7 text-[color:var(--site-pre-fg)]">
            <div className="mb-3 text-xs text-[color:var(--site-faint)]">从源码启动桌面版</div>
            <pre className="overflow-x-auto whitespace-pre font-mono">
              {`# 首次运行或代码有更新：重建预编译产物
mise run start-build

# 直接用已有产物启动
mise run start`}
            </pre>
            <div className="mt-4 mb-3 text-xs text-[color:var(--site-faint)]">Web 端 + 后端</div>
            <pre className="overflow-x-auto whitespace-pre font-mono">pnpm dev:web</pre>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
        <SectionTitle>功能一览</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Link
              key={feature.title}
              className="group rounded-xl border border-[color:var(--site-border)] p-5 transition-colors hover:bg-[color:var(--site-bg-soft)]"
              to={feature.to}
            >
              <div className="font-semibold">{feature.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--site-fg-subtle)]">
                {feature.description}
              </p>
              <div className="mt-3 text-sm text-[color:var(--site-brand)] opacity-0 transition-opacity group-hover:opacity-100">
                阅读文档 →
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="border-y border-[color:var(--site-border)] bg-[color:var(--site-bg-soft)]">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
          <SectionTitle>理念</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PRINCIPLES.map((principle) => (
              <div
                key={principle.name}
                className="rounded-xl border border-[color:var(--site-border)] bg-[color:var(--site-bg)] p-5"
              >
                <div className="font-semibold">{principle.name}</div>
                <p className="mt-2 text-sm leading-relaxed text-[color:var(--site-fg-subtle)]">
                  {principle.text}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
        <SectionTitle>一套仓库，三种形态</SectionTitle>
        <div className="grid gap-4 md:grid-cols-3">
          {CLIENTS.map((client) => (
            <div
              key={client.name}
              className="rounded-xl border border-[color:var(--site-border)] p-5"
            >
              <div className="font-semibold">{client.name}</div>
              <p className="mt-2 text-sm leading-relaxed text-[color:var(--site-fg-subtle)]">
                {client.text}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
