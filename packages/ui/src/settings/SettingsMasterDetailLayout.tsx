import type { ReactNode } from "react";

/**
 * 设置页的**双栏主从**外壳：左侧导航栏 + 右侧详情区，共用一套栅格、边框与内边距。
 *
 * 从 `model-provider-section/SectionLayout.tsx` 抽出：那个文件里的网格、卡片外壳和
 * 详情区内边距是纯展示层的东西，不含任何 Model Provider 语义（导航项、拖拽排序、
 * 详情刷新信号都通过 props 传进来），而「数据源 › 搜索引擎」需要同一套版式。
 * 复制一份的后果是改一次断点宽度要改两处，两处不一致时只有供应商那半边是对的。
 *
 * 窄屏下左栏压到 56px 只剩图标位，这是「侧栏 + 详情」在手机 Web 上唯一可行的排法。
 */
export function SettingsMasterDetailLayout({
  navigation,
  children,
  minHeightClassName = "min-h-[36rem]",
  testId,
}: {
  navigation: ReactNode;
  children: ReactNode;
  minHeightClassName?: string;
  testId?: string;
}) {
  return (
    <div className="overflow-clip rounded-xl border border-border bg-card">
      <div
        className={`grid ${minHeightClassName} grid-cols-[56px_minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]`}
        data-testid={testId}
      >
        <div className="min-w-0 border-r border-border" data-settings-master-navigation="true">
          {navigation}
        </div>
        <div
          className="relative min-w-0 p-4 pb-20 sm:p-6 sm:pb-24"
          data-settings-master-detail="true"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * 主从布局的导航栏内容外壳。窄屏（`md` 以下）导航项只留图标位，标题靠 `sr-only`
 * 保留给读屏软件——手机上既不挤占详情区宽度，又不至于对辅助技术不可见。
 */
export function SettingsMasterNavigation({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto p-2" data-settings-master-navigation-scroll="true">
      {children}
    </div>
  );
}
