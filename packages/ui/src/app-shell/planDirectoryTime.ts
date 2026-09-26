import type { Locale } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 计划创建时间的展示值：`label` 走行内，`title` 给悬停全文。
 */
export interface PlanCreatedAtLabel {
  label: string;
  title: string;
}

function formatClockTime(timestamp: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    // 显示到秒：frontmatter 的 `created` 是毫秒精度，两份计划完全可能落在同一分钟内，
    // 只到分钟会让用户分不出哪条更新。
    second: "2-digit",
  }).format(timestamp);
}

function formatCalendarDate(
  timestamp: number,
  includeYear: boolean,
  formatMessage: IntlInstance["formatMessage"],
): string {
  const date = new Date(timestamp);
  return formatMessage(
    {
      id: includeYear ? "planDirectory.time.dateYearMonthDay" : "planDirectory.time.dateMonthDay",
    },
    {
      year: String(date.getFullYear()),
      month: String(date.getMonth() + 1),
      day: String(date.getDate()),
    },
  );
}

function joinDateAndTime(
  timestamp: number,
  includeYear: boolean,
  formatMessage: IntlInstance["formatMessage"],
  locale: Locale,
): string {
  return formatMessage(
    { id: "planDirectory.time.date" },
    {
      date: formatCalendarDate(timestamp, includeYear, formatMessage),
      time: formatClockTime(timestamp, locale),
    },
  );
}

/**
 * 计划目录行内展示的创建时间。
 *
 * **刻意是绝对时间，不是「N 天前」**：计划常常是几周前定的，相对文案回答不了「这份是
 * 什么时候定的」；也不用「今天/昨天」，侧栏长时间开着时这类词会在用户眼皮底下过期，
 * 而面板没有为刷新时间戳专门起 ticker。跨年补年份，`title` 始终给含年份的完整本地时间。
 *
 * `createdAt` 是计划文件 frontmatter 的 `created`（ISO 字符串），由运行时解析后随目录条目
 * 透传——renderer 不碰文件系统、也不自己解析 frontmatter。
 *
 * 缺席或解析不出（`NaN`）时返回 null，由调用方整行不渲染——不留占位、不显示 Invalid Date。
 */
export function formatPlanCreatedAt({
  createdAt,
  formatMessage,
  locale,
  now = new Date(),
}: {
  createdAt: string | undefined;
  formatMessage: IntlInstance["formatMessage"];
  locale: Locale;
  now?: Date;
}): PlanCreatedAtLabel | null {
  if (!createdAt) return null;
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return null;
  const includeYear = new Date(timestamp).getFullYear() !== now.getFullYear();
  return {
    label: joinDateAndTime(timestamp, includeYear, formatMessage, locale),
    title: joinDateAndTime(timestamp, true, formatMessage, locale),
  };
}
