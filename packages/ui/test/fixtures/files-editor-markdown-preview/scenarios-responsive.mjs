import { MD_PATH, MD_SAVED, TITLE_READABLE_MIN_WIDTH, TXT_PATH } from "./constants.mjs";
import {
  checkActiveTabReachable,
  checkActiveTabReadable,
  checkControlClickable,
  checkMarkdownHeaderAbsent,
  checkResponsiveLayout,
  layoutMetrics,
} from "./layout.mjs";
import {
  clickCandidate,
  fillSource,
  findSaveButton,
  pickMode,
  poll,
  scanModeControls,
  setTheme,
  waitForMode,
} from "./probes.mjs";

/**
 * 响应式与国际化布局：暗色桌面、375/320 窄屏、窄分屏，以及 en-US 下的窄屏。
 * 只读取本夹具自己启动的静态站点。
 */
export async function runResponsiveScenarios({ page, check, shot, mount, snapshot, pathInfo }) {
  const clickTab = (groupId, viewId) =>
    page.evaluate(
      ({ groupId: id, viewId: target }) => {
        const tab = document.querySelector(
          `[data-editor-group-id="${CSS.escape(id)}"] [data-editor-view-id="${CSS.escape(target)}"]`,
        );
        if (tab instanceof HTMLElement) tab.click();
      },
      { groupId, viewId },
    );

  // 页面内 DOM.click 不会像 Playwright locator.click 那样自动把目标滚入视口；
  // 横滚只能由生产在激活后的生命周期里校正。
  const activateByDomClick = async (groupId, viewId) => {
    await clickTab(groupId, viewId);
    await poll(
      async () =>
        (await snapshot()).groups.find((group) => group.id === groupId)?.activeViewId === viewId,
    );
  };
  const waitForActiveTabReachable = (groupId) =>
    poll(async () => {
      const current = await layoutMetrics(page, groupId);
      const active = current.tabs.find((tab) => tab.selected);
      return Boolean(
        active &&
        active.visibleTitleWidth >= TITLE_READABLE_MIN_WIDTH &&
        active.hit &&
        current.documentOverflow <= 1 &&
        current.bodyOverflow <= 1,
      );
    });

  // 暗色桌面：主题类、外壳背景与控件布局。
  await page.setViewportSize({ width: 1280, height: 800 });
  await setTheme(page, true);
  await mount("markdown");
  const darkView = await pathInfo(MD_PATH);
  await waitForMode(page, darkView.groupId, "source");
  await page.waitForTimeout(300);
  let metrics = await layoutMetrics(page, darkView.groupId);
  check("dark: 根节点应用暗色主题", metrics.dark === true, metrics);
  check(
    "dark: 夹具外壳背景解析为深色",
    typeof metrics.appLuminance === "number" && metrics.appLuminance < 0.2,
    { appLuminance: metrics.appLuminance, appBackground: metrics.appBackground },
  );
  checkResponsiveLayout(check, "dark-desktop", metrics, 1, {
    headerTexts: ["Markdown", "预览"],
  });
  let controls = await scanModeControls(page, darkView.groupId);
  await clickCandidate(page, darkView.groupId, pickMode(controls.candidates, "preview"));
  await waitForMode(page, darkView.groupId, "preview");
  metrics = await layoutMetrics(page, darkView.groupId);
  checkResponsiveLayout(check, "dark-desktop-preview", metrics, 1, {
    headerTexts: ["Markdown", "预览"],
  });
  await shot(page, "06-dark-desktop-preview");

  // 375 窄屏 + 三个标签：切换/保存不能把标签挤没，也不能横向溢出。
  await setTheme(page, false);
  await page.setViewportSize({ width: 375, height: 720 });
  await mount("mixed");
  const narrowTxt = await pathInfo(TXT_PATH);
  const narrowMd = await pathInfo(MD_PATH);
  await page.waitForTimeout(300);
  metrics = await layoutMetrics(page, narrowTxt.groupId);
  checkResponsiveLayout(check, "narrow375-mixed", metrics, 3, { requireSwitch: false });
  check(
    "narrow375: 三个标签在 375px 下仍有非零可见宽度",
    metrics.tabs.every((tab) => tab.visibleWidth > 0),
    metrics.tabs,
  );
  checkMarkdownHeaderAbsent(check, "narrow375-mixed", metrics);
  await clickTab(narrowMd.groupId, narrowMd.viewId);
  await poll(async () => {
    const next = await scanModeControls(page, narrowMd.groupId);
    return pickMode(next.candidates, "preview");
  });
  const narrowDraftToken = `NARROW-DRAFT-${Date.now()}`;
  const narrowDraft = `# Guide\n\nSAVED-BODY\n\n${narrowDraftToken}`;
  await fillSource(page, narrowMd.groupId, narrowDraft);
  const narrowControls = await scanModeControls(page, narrowMd.groupId);
  await clickCandidate(page, narrowMd.groupId, pickMode(narrowControls.candidates, "preview"));
  await waitForMode(page, narrowMd.groupId, "preview");
  await findSaveButton(page, narrowMd.groupId);
  metrics = await layoutMetrics(page, narrowMd.groupId);
  checkResponsiveLayout(check, "narrow375-preview-dirty", metrics, 3, {
    headerTexts: ["Markdown", "预览"],
  });
  check("narrow375: 预览态仍显示保存按钮", Boolean(metrics.saveRect), metrics);
  const narrowSave = await page.evaluate((id) => {
    const button = document.querySelector(
      `[data-editor-group-id="${CSS.escape(id)}"] [data-e2e-save-button]`,
    );
    if (button instanceof HTMLElement) button.click();
    return window.__filesE2E.saveCalls.length;
  }, narrowMd.groupId);
  check("narrow375: 预览态保存仍可用", narrowSave === 1, { saveCalls: narrowSave });
  await shot(page, "07-narrow375-preview-dirty");

  // 320 窄屏：同一组三个标签的极限收缩。
  await page.setViewportSize({ width: 320, height: 640 });
  await mount("mixed");
  const narrow320Txt = await pathInfo(TXT_PATH);
  await page.waitForTimeout(300);
  metrics = await layoutMetrics(page, narrow320Txt.groupId);
  checkResponsiveLayout(check, "narrow320-mixed", metrics, 3, { requireSwitch: false });
  checkMarkdownHeaderAbsent(check, "narrow320-mixed", metrics);
  await shot(page, "08-narrow320-mixed");

  const narrow320Md = await pathInfo(MD_PATH);
  await clickTab(narrow320Md.groupId, narrow320Md.viewId);
  await poll(async () => {
    const next = await scanModeControls(page, narrow320Md.groupId);
    return pickMode(next.candidates, "preview");
  });
  const narrow320Draft = `# Guide\n\nSAVED-BODY\n\nNARROW-320-DRAFT-${Date.now()}`;
  await fillSource(page, narrow320Md.groupId, narrow320Draft);
  const narrow320Controls = await scanModeControls(page, narrow320Md.groupId);
  await clickCandidate(
    page,
    narrow320Md.groupId,
    pickMode(narrow320Controls.candidates, "preview"),
  );
  await waitForMode(page, narrow320Md.groupId, "preview");
  await findSaveButton(page, narrow320Md.groupId);
  metrics = await layoutMetrics(page, narrow320Md.groupId);
  checkResponsiveLayout(check, "narrow320-preview-dirty", metrics, 3, {
    headerTexts: ["Markdown", "预览"],
  });
  check(
    "narrow320: 预览态同时容纳切换与保存按钮",
    Boolean(metrics.switchRect && metrics.saveRect),
    metrics,
  );
  const narrow320Save = await page.evaluate((id) => {
    const button = document.querySelector(
      `[data-editor-group-id="${CSS.escape(id)}"] [data-e2e-save-button]`,
    );
    if (button instanceof HTMLElement) button.click();
    return window.__filesE2E.saveCalls.length;
  }, narrow320Md.groupId);
  check("narrow320: 预览态保存仍可用", narrow320Save === 1, { saveCalls: narrow320Save });
  await shot(page, "09-narrow320-preview-dirty");

  // 分屏窄宽：每个编辑组独立拥有切换控件，标签不被挤没。
  await page.setViewportSize({ width: 375, height: 720 });
  await mount("split");
  await poll(async () => (await snapshot()).groups.length === 2);
  const splitGroups = (await snapshot()).groups;
  for (const [index, group] of splitGroups.entries()) {
    await waitForMode(page, group.id, "source");
    const paneMetrics = await layoutMetrics(page, group.id);
    checkResponsiveLayout(check, `split-narrow375-${index}`, paneMetrics, 1, {
      headerTexts: ["Markdown", "预览"],
    });
  }
  const firstSplitControls = await scanModeControls(page, splitGroups[0].id);
  await clickCandidate(page, splitGroups[0].id, pickMode(firstSplitControls.candidates, "preview"));
  await waitForMode(page, splitGroups[0].id, "preview");
  await waitForMode(page, splitGroups[1].id, "source");
  const splitMetrics = await layoutMetrics(page, splitGroups[0].id);
  checkResponsiveLayout(check, "split-narrow375-preview", splitMetrics, 1, {
    headerTexts: ["Markdown", "预览"],
  });
  await shot(page, "10-split-narrow375-preview");

  // 横滚回归 1：320px 单组 4 个标签（每个至少 96px），先停在首标签，
  // 再用页面内 DOM.click 激活最后一个标签，验证生产生命周期把活动标签滚入可视区。
  await page.setViewportSize({ width: 320, height: 640 });
  await mount("many");
  const manySnapshot = await snapshot();
  const manyGroup = manySnapshot.groups.find((group) => group.views.length >= 4);
  check("narrow320-four-tabs: 至少打开 4 个标签", Boolean(manyGroup), manySnapshot.groups);
  if (!manyGroup) throw new Error("many 场景没有 4 个标签");
  const firstViewId = manyGroup.views[0].id;
  const lastViewId = manyGroup.views.at(-1).id;
  const manyMetrics = await poll(async () => {
    const current = await layoutMetrics(page, manyGroup.id);
    return current.tabs.length >= 4 && current.tabs.every((tab) => tab.width >= 95.5)
      ? current
      : false;
  });
  check(
    "narrow320-four-tabs: 每个标签保持 96px 最小宽度",
    manyMetrics.tabs.every((tab) => tab.width >= 95.5),
    manyMetrics.tabs.map((tab) => tab.width),
  );
  check("narrow320-four-tabs: 初始活动标签是首标签", manyGroup.activeViewId === firstViewId, {
    activeViewId: manyGroup.activeViewId,
    firstViewId,
  });
  check(
    "narrow320-four-tabs: 激活前滚动容器在起点",
    manyMetrics.tabsContainerScrollLeft === 0,
    manyMetrics.tabsContainerScrollLeft,
  );
  await activateByDomClick(manyGroup.id, lastViewId);
  await waitForActiveTabReachable(manyGroup.id);
  const manyActiveMetrics = await layoutMetrics(page, manyGroup.id);
  checkActiveTabReachable(check, "narrow320-four-tabs-last", manyActiveMetrics);
  check(
    "narrow320-four-tabs: 激活的是最后标签",
    (await snapshot()).groups.find((group) => group.id === manyGroup.id)?.activeViewId ===
      lastViewId,
    manyActiveMetrics.tabs.find((tab) => tab.selected),
  );
  check(
    "narrow320-four-tabs: 激活后滚动容器发生滚动",
    manyActiveMetrics.tabsContainerScrollLeft > 0,
    manyActiveMetrics.tabsContainerScrollLeft,
  );
  await shot(page, "13-narrow320-four-tabs-last");

  // 横滚回归 2：375px 分屏，左侧 3 个标签（每个至少 96px），
  // 同样用页面内 DOM.click 激活第 3 个标签。
  await page.setViewportSize({ width: 375, height: 720 });
  await mount("split-many");
  const splitManySnapshot = await poll(async () => {
    const current = await snapshot();
    return current.groups.length === 2 ? current : false;
  });
  const crowdedGroup = splitManySnapshot.groups.find((group) => group.views.length >= 3);
  check(
    "split375-three-tabs: 分屏单侧至少 3 个标签",
    Boolean(crowdedGroup),
    splitManySnapshot.groups,
  );
  if (!crowdedGroup) throw new Error("split-many 场景没有 3 个标签的一侧");
  const initialSplitMetrics = await poll(async () => {
    const current = await layoutMetrics(page, crowdedGroup.id);
    return current.tabs.length >= 3 && current.tabs.every((tab) => tab.width >= 95.5)
      ? current
      : false;
  });
  check(
    "split375-three-tabs: 每个标签保持 96px 最小宽度",
    initialSplitMetrics.tabs.every((tab) => tab.width >= 95.5),
    initialSplitMetrics.tabs.map((tab) => tab.width),
  );
  check(
    "split375-three-tabs: 初始活动标签是首标签",
    crowdedGroup.activeViewId === crowdedGroup.views[0].id,
    { activeViewId: crowdedGroup.activeViewId, first: crowdedGroup.views[0] },
  );
  const thirdViewId = crowdedGroup.views[2].id;
  await activateByDomClick(crowdedGroup.id, thirdViewId);
  await waitForActiveTabReachable(crowdedGroup.id);
  const splitActiveMetrics = await layoutMetrics(page, crowdedGroup.id);
  checkActiveTabReachable(check, "split375-three-tabs-third", splitActiveMetrics);
  check(
    "split375-three-tabs: 激活的是第 3 个标签",
    (await snapshot()).groups.find((group) => group.id === crowdedGroup.id)?.activeViewId ===
      thirdViewId,
    splitActiveMetrics.tabs.find((tab) => tab.selected),
  );
  check(
    "split375-three-tabs: 激活后滚动容器发生滚动",
    splitActiveMetrics.tabsContainerScrollLeft > 0,
    splitActiveMetrics.tabsContainerScrollLeft,
  );
  await shot(page, "14-split375-three-tabs-third");

  // ---------------------------------------------------- en-US 窄屏
  // 英文切换文案（Source / Preview）比中文更长，窄屏仍要可点、标题可读、无横溢。
  await setTheme(page, false);
  const locale = await page.evaluate(() => {
    window.__filesE2E.setLocale("en-US");
    return window.__filesE2E.locale();
  });
  check("i18n: 夹具可切换到 en-US", locale === "en-US", locale);
  await poll(async () => page.evaluate(() => window.__filesE2E.locale() === "en-US"));

  for (const width of [375, 320]) {
    const name = `en-narrow${width}-preview`;
    await page.setViewportSize({ width, height: width === 320 ? 640 : 720 });
    await mount("mixed");
    const enMd = await pathInfo(MD_PATH);
    await page.waitForTimeout(300);
    await clickTab(enMd.groupId, enMd.viewId);
    await poll(async () => {
      const next = await scanModeControls(page, enMd.groupId);
      return pickMode(next.candidates, "preview");
    });
    const draft = `# Guide\n\nSAVED-BODY\n\nEN-${width}-DRAFT-${Date.now()}`;
    await fillSource(page, enMd.groupId, draft);
    const enControls = await scanModeControls(page, enMd.groupId);
    const enPreview = pickMode(enControls.candidates, "preview");
    check(
      `${name}: 切换控件使用英文 Preview 文案`,
      /preview/i.test([enPreview?.ariaLabel, enPreview?.title, enPreview?.text].join(" ")),
      enPreview,
    );
    await clickCandidate(page, enMd.groupId, enPreview);
    await waitForMode(page, enMd.groupId, "preview");
    await findSaveButton(page, enMd.groupId);
    const enMetrics = await layoutMetrics(page, enMd.groupId);
    checkResponsiveLayout(check, name, enMetrics, 3, {
      headerTexts: ["Markdown", "Preview"],
    });
    checkActiveTabReadable(check, name, enMetrics);
    checkControlClickable(check, name, enMetrics, "switch", "源码/预览切换");
    checkControlClickable(check, name, enMetrics, "save", "保存");
    const beforeSave = (await snapshot()).saveCalls.length;
    await page.locator(`[data-editor-group-id="${enMd.groupId}"] [data-e2e-save-button]`).click();
    const saved = await poll(async () => (await snapshot()).saveCalls.length > beforeSave);
    check(`${name}: 英文预览态保存可点击并落账`, saved === true);
    await shot(page, `11-en-narrow${width}-preview`);
  }

  // en-US 窄分屏：两侧都保持可读标题，切换/保存仍可点击。
  await page.setViewportSize({ width: 375, height: 720 });
  await mount("split");
  await poll(async () => (await snapshot()).groups.length === 2);
  const enSplitGroups = (await snapshot()).groups;
  const enSplitDraft = `${MD_SAVED}\n\nEN-SPLIT-${Date.now()}`;
  await fillSource(page, enSplitGroups[0].id, enSplitDraft);
  for (const [index, group] of enSplitGroups.entries()) {
    await waitForMode(page, group.id, "source");
    await findSaveButton(page, group.id);
    const paneMetrics = await layoutMetrics(page, group.id);
    const splitName = `en-split-narrow375-${index}`;
    checkResponsiveLayout(check, splitName, paneMetrics, 1, {
      headerTexts: ["Markdown", "Preview"],
    });
    checkActiveTabReadable(check, splitName, paneMetrics);
    checkControlClickable(check, splitName, paneMetrics, "switch", "源码/预览切换");
    checkControlClickable(check, splitName, paneMetrics, "save", "保存");
  }
  const enSplitControls = await scanModeControls(page, enSplitGroups[0].id);
  await clickCandidate(page, enSplitGroups[0].id, pickMode(enSplitControls.candidates, "preview"));
  await waitForMode(page, enSplitGroups[0].id, "preview");
  await waitForMode(page, enSplitGroups[1].id, "source");
  const beforeSplitSave = (await snapshot()).saveCalls.length;
  await page
    .locator(`[data-editor-group-id="${enSplitGroups[1].id}"] [data-e2e-save-button]`)
    .click();
  const splitSaved = await poll(async () => (await snapshot()).saveCalls.length > beforeSplitSave);
  check("en-split-narrow375: 英文分屏保存可点击并落账", splitSaved === true);
  await shot(page, "12-en-split-narrow375-preview");
}
