// 更新日志版本注册表：官网左侧版本导航的唯一事实源。
// slug 即仓库根 changelogs/ 下的文件名（不含 .md）；发版时新增版本文件并在这里追加一行。

type ChangelogVersion = {
  slug: string;
  title: string;
  date: string;
};

export const CHANGELOG_VERSIONS: ChangelogVersion[] = [
  { slug: "v4.0", title: "v4.0", date: "2026-10-08" },
];
