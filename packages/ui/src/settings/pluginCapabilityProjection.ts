import {
  resolveManagedPluginDisplay,
  type StorePluginItem,
} from "@/settings/pluginStoreListing.js";
import type {
  SkillSummary,
  ZCodeCommand,
  ZCodeInstalledPluginSummary,
  ZCodePluginInfo,
  ZCodePluginScope,
} from "@zcode/shared";
import { compareDocumentPluginPriority, isPluginCommand, isUserCommand } from "@zcode/shared";
import { pluginSearchMatches } from "@/settings/pluginSearch.js";
import { isOfficialBuiltinSkill } from "@/lib/builtinSkillI18n.js";

function canonicalPluginName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function selectBuiltInPlugins(
  plugins: readonly ZCodePluginInfo[],
  installedPlugins: readonly ZCodeInstalledPluginSummary[],
): ZCodePluginInfo[] {
  const installedIds = new Set(installedPlugins.map((plugin) => plugin.id));
  return plugins.filter((plugin) => plugin.source === "official" && !installedIds.has(plugin.id));
}

/**
 * 第四签「外部插件」的插件级过滤：只列带 binaryPlugin 标记的条目，
 * 与组件 kind 无关。无组件的二进制插件照样是一个列表条目。
 */
export function selectBinaryPlugins(plugins: readonly ZCodePluginInfo[]): ZCodePluginInfo[] {
  return plugins.filter((plugin) => plugin.binaryPlugin != null);
}

/**
 * 二进制插件无用户级启停意图（是否运行由依赖 provider 派生），
 * 不渲染插件级启停开关与安装/卸载按钮。普通插件不受影响。
 */
export function shouldRenderPluginToggle(plugin: Pick<ZCodePluginInfo, "binaryPlugin">): boolean {
  return plugin.binaryPlugin == null;
}

interface PluginSettingsGroups {
  installed: ZCodePluginInfo[];
  builtIn: ZCodePluginInfo[];
}

/**
 * 设置页只展示已物化的插件；Agent 为保留目标 Host 配置而返回的 missing 投影不能
 * 进入 Installed / Built-in，否则会出现“已安装分组 + 未安装状态”的矛盾行。
 */
export function partitionPluginsForSettings(
  plugins: readonly ZCodePluginInfo[],
  builtInPluginIds: ReadonlySet<string>,
): PluginSettingsGroups {
  const materializedPlugins = plugins.filter((plugin) => plugin.packageStatus !== "missing");
  return {
    installed: materializedPlugins.filter((plugin) => !builtInPluginIds.has(plugin.id)),
    builtIn: materializedPlugins
      .filter((plugin) => builtInPluginIds.has(plugin.id))
      .toSorted((left, right) => compareDocumentPluginPriority(left.id, right.id)),
  };
}

export function filterPluginsByQuery(
  plugins: readonly ZCodePluginInfo[],
  query: string,
  itemsById?: ReadonlyMap<string, StorePluginItem>,
  locale = "en-US",
): ZCodePluginInfo[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...plugins];
  return plugins.filter((plugin) => {
    const candidate = itemsById?.get(plugin.id);
    const item = candidate?.id === plugin.id ? candidate : undefined;
    const display = resolveManagedPluginDisplay(plugin, item, locale);
    return pluginSearchMatches(
      normalizedQuery,
      [plugin.name, plugin.id, plugin.marketplace, display.name, display.description],
      [
        plugin.name,
        item?.listing?.displayName,
        ...Object.values(item?.listing?.displayNameI18n ?? {}),
      ],
    );
  });
}

export function selectPluginsForScope(
  plugins: readonly ZCodePluginInfo[],
  _installedPlugins: readonly ZCodeInstalledPluginSummary[],
  _scope: ZCodePluginScope,
): ZCodePluginInfo[] {
  // User / Workspace 已经由 plugins/list(configScope) 返回各自的配置投影。
  // 这里不能再按 enabledSource/rootSource 做“归属”过滤，否则 Workspace 会丢掉继承 User
  // 的 Host inventory，User 也会被当前 Workspace override 污染后的来源字段误删。
  return [...plugins];
}

export function selectSkillsForScope(
  skills: readonly SkillSummary[],
  scopedPlugins: readonly Pick<ZCodePluginInfo, "id" | "name" | "enabled">[],
  scope: ZCodePluginScope,
): SkillSummary[] {
  const enabledPlugins = scopedPlugins.filter((plugin) => plugin.enabled);
  const scopedPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  const scopedPluginIdsByName = new Map<string, string[]>();
  for (const plugin of enabledPlugins) {
    const name = canonicalPluginName(plugin.name);
    scopedPluginIdsByName.set(name, [...(scopedPluginIdsByName.get(name) ?? []), plugin.id]);
  }
  return skills.filter((skill) => {
    if (skill.scope !== "plugin") {
      return skill.scope === scope;
    }
    if (skill.pluginId) return scopedPluginIds.has(skill.pluginId);
    const matchingIds = skill.pluginName
      ? scopedPluginIdsByName.get(canonicalPluginName(skill.pluginName))
      : undefined;
    // 旧协议没有 pluginId 时，仅在名称唯一的兼容场景下回退，避免跨 marketplace 合并。
    return matchingIds?.length === 1;
  });
}

/**
 * 插件 store 与当前目标失配时，调用方会向 selectSkillsForScope 传空数组，
 * 导致全部 plugin 技能被丢弃。这里仅把系统技能补回来：技能扫描结果已按插件
 * 启用状态过滤过，且官方内置插件默认启用，因此失配只是投影层的瞬态问题
 * （首挂载先 false）或他页覆写同一 store 的 configScope 造成的持续 false，
 * 系统技能不应受其影响。非系统 plugin 技能保持原门禁不变。
 */
export function retainSystemSkillsOnStoreMismatch(
  selected: readonly SkillSummary[],
  allProviderSkills: readonly SkillSummary[],
): SkillSummary[] {
  const selectedIds = new Set(selected.map((skill) => skill.id));
  const retained = allProviderSkills.filter(
    (skill) =>
      skill.scope === "plugin" && isOfficialBuiltinSkill(skill) && !selectedIds.has(skill.id),
  );
  return [...selected, ...retained];
}

export function selectCommandsForScope(
  commands: readonly ZCodeCommand[],
  scopedPlugins: readonly Pick<ZCodePluginInfo, "id" | "name" | "enabled">[],
  scope: ZCodePluginScope,
): ZCodeCommand[] {
  const enabledPlugins = scopedPlugins.filter((plugin) => plugin.enabled);
  const scopedPluginIds = new Set(enabledPlugins.map((plugin) => plugin.id));
  const scopedPluginIdsByName = new Map<string, string[]>();
  for (const plugin of enabledPlugins) {
    const name = canonicalPluginName(plugin.name);
    scopedPluginIdsByName.set(name, [...(scopedPluginIdsByName.get(name) ?? []), plugin.id]);
  }
  return commands.filter((command) => {
    if (isUserCommand(command)) {
      return command.location.scope === (scope === "user" ? "user" : "project");
    }
    if (!isPluginCommand(command)) return false;
    const marketplace = command.pluginMarketplace?.trim() ?? "";
    const pluginId = `${command.pluginName.trim()}@${marketplace}`;
    if (marketplace) return scopedPluginIds.has(pluginId);
    const matchingIds = scopedPluginIdsByName.get(canonicalPluginName(command.pluginName));
    return matchingIds?.length === 1;
  });
}

interface SkillSourceGroup {
  id: string;
  label: string;
  pluginId?: string;
  skills: SkillSummary[];
  source: "direct" | "plugin" | "system";
}

export function groupScopedSkillsBySource(
  skills: readonly SkillSummary[],
  directLabel: string,
): SkillSourceGroup[] {
  const direct: SkillSummary[] = [];
  const system: SkillSummary[] = [];
  const pluginGroups = new Map<string, SkillSourceGroup>();
  for (const skill of skills) {
    if (skill.scope !== "plugin") {
      direct.push(skill);
      continue;
    }
    // 官方内置技能本质是 plugin scope，但展示上单列为置底的系统分组。
    if (isOfficialBuiltinSkill(skill)) {
      system.push(skill);
      continue;
    }
    const pluginName = skill.pluginName?.trim();
    if (!pluginName) continue;
    const pluginId = skill.pluginId?.trim();
    const id = pluginId || canonicalPluginName(pluginName);
    const group = pluginGroups.get(id) ?? {
      id: `plugin:${id}`,
      label: pluginName,
      ...(pluginId ? { pluginId } : {}),
      skills: [],
      source: "plugin" as const,
    };
    group.skills.push(skill);
    pluginGroups.set(id, group);
  }
  return [
    ...(direct.length > 0
      ? [
          {
            id: "direct",
            label: directLabel,
            skills: direct,
            source: "direct" as const,
          },
        ]
      : []),
    ...Array.from(pluginGroups.values()).sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
    ...(system.length > 0
      ? [
          {
            id: "system",
            label: "",
            skills: system,
            source: "system" as const,
          },
        ]
      : []),
  ];
}
