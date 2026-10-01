// 导航注册表：官网信息架构的唯一事实源。
// slug 即 src/content/docs/ 下的文件名；调整顺序、改名都在这里做。

type DocPageMeta = {
  slug: string;
  title: string;
  description: string;
};

type DocGroup = {
  key: string;
  title: string;
  pages: DocPageMeta[];
};

export const DOC_GROUPS: DocGroup[] = [
  {
    key: "start",
    title: "开始使用",
    pages: [
      { slug: "welcome", title: "欢迎", description: "YCode 是什么，与上游 ZCode 的关系" },
      { slug: "install", title: "安装与启动", description: "环境要求、桌面版与 Web 端的构建启动" },
      { slug: "configuration", title: "配置", description: "用户与工作区作用域、配置文件与优先级" },
      { slug: "faq", title: "常见问题", description: "高频问题与排查指引" },
    ],
  },
  {
    key: "core",
    title: "核心功能",
    pages: [
      { slug: "goal", title: "目标模式", description: "/goal 启动持续自主循环，朝着目标工作" },
      { slug: "plan", title: "计划模式", description: "先探索与计划，批准后再执行" },
      { slug: "task-management", title: "任务管理", description: "任务列表、后台任务与输出卡" },
      { slug: "subagents", title: "子代理", description: "前台执行的子代理、持久身份与续跑" },
      { slug: "context", title: "上下文与压缩", description: "上下文用量、自动压缩与手动 Compact" },
      { slug: "workflows", title: "动态工作流", description: "用 TypeScript 脚本编排多个子代理" },
      { slug: "automations", title: "自动化任务", description: "按 cron 或延迟计划重复运行任务" },
      { slug: "idle-tasks", title: "闲时任务", description: "把可推迟的工作丢进空闲算力队列" },
      { slug: "shortcuts", title: "键盘快捷键", description: "快捷键的查看、编辑、冲突与恢复" },
    ],
  },
  {
    key: "official-providers",
    title: "官方 Provider",
    pages: [
      {
        slug: "zhipu",
        title: "智谱 Z.AI / BigModel",
        description: "账号登录、Coding Plan 与套餐额度",
      },
      { slug: "opencode", title: "OpenCode", description: "接入模板、套餐额度与请求归因" },
    ],
  },
  {
    key: "model-access",
    title: "模型接入",
    pages: [
      {
        slug: "providers",
        title: "其他内置供应商",
        description: "快捷接入的第三方供应商、自定义端点与模型级配置",
      },
      {
        slug: "network",
        title: "网络与代理",
        description: "全局代理、证书与按模型/按 MCP 的出口策略",
      },
    ],
  },
  {
    key: "extend",
    title: "扩展能力",
    pages: [
      { slug: "skills", title: "技能", description: "SKILL.md、发现顺序与同名遮蔽" },
      {
        slug: "commands",
        title: "自定义命令",
        description: "Markdown 命令、frontmatter 与参数展开",
      },
      { slug: "hooks", title: "Hooks", description: "七种事件、matcher 与退出码语义" },
      { slug: "mcp", title: "MCP", description: "服务器配置、合并规则与自动连接" },
      { slug: "plugins", title: "插件", description: "插件清单、变量与市场安装" },
    ],
  },
  {
    key: "remote",
    title: "远程与安全",
    pages: [
      {
        slug: "remote",
        title: "Web 与手机远控",
        description: "局域网直连桌面 Host，同一工作区同一会话",
      },
      { slug: "safety", title: "安全与权限", description: "审批、确认与默认关闭的重型能力" },
    ],
  },
];

const ALL_DOC_PAGES: DocPageMeta[] = DOC_GROUPS.flatMap((group) => group.pages);

export function findDocPage(slug: string): DocPageMeta | undefined {
  return ALL_DOC_PAGES.find((page) => page.slug === slug);
}

export function docNeighbors(slug: string): {
  prev: DocPageMeta | undefined;
  next: DocPageMeta | undefined;
} {
  const index = ALL_DOC_PAGES.findIndex((page) => page.slug === slug);
  if (index < 0) return { prev: undefined, next: undefined };
  return {
    prev: index > 0 ? ALL_DOC_PAGES[index - 1] : undefined,
    next: index >= 0 && index < ALL_DOC_PAGES.length - 1 ? ALL_DOC_PAGES[index + 1] : undefined,
  };
}
