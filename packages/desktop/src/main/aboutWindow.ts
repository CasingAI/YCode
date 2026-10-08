interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  upstreamVersionLine: string;
  versionLabel: string;
  okButtonLabel: string;
  iconDataUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
        /* 关闭时由内容自己淡出，淡完 renderer 才关窗——窗口级的渐出对象是空窗口，
           内容不参与，才会出现“内容先消失、动画再走”。 */
        opacity: 1;
        transition: opacity 160ms ease-out;
      }

      body.is-closing {
        opacity: 0;
      }

      @media (prefers-reduced-motion: reduce) {
        body {
          transition-duration: 0ms;
        }
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 288px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      /* 只做 52px 的居中占位。素材（build/icon.png）自带圆角和四周约一成的透明留白，
         这里再叠圆角与投影会画在留白外圈上，把那一圈背景压暗、中心相对更亮，
         看起来像一块浅色板托着图标。装饰交给素材本身。 */
      .app-icon {
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      /* 60px 是补回素材那圈留白后的尺寸：可见部分落在 52px 左右，
         与替换前那枚内联标识的视觉重量一致。容器不裁切，两侧对称溢出到卡片内边距。 */
      .app-logo {
        width: 60px;
        height: 60px;
        display: block;
      }

      .title {
        margin: 14px 0 0;
        font-size: 13.5px;
        line-height: 1.5;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-size: 13px;
        line-height: 1.5;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }


      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }
      }
    </style>
  </head>
  <body>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          ${
            // 之前这里内联了一段写死的品牌标识 SVG，图标资源整体替换（例如换掉
            // icon.icns / icon.ico / 各尺寸 PNG）时它毫发无损，导致关于面板与 Dock
            // 显示两套不同的图标。现在改为渲染调用方从 icon.png 读出的 data URL，
            // 让图标有唯一来源；读取失败时传空串，整个图标位不输出。
            input.iconDataUrl
              ? `<div class="app-icon" aria-hidden="true"><img class="app-logo" src="${input.iconDataUrl}" alt="" /></div>`
              : ""
          }
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            ${input.upstreamVersionLine ? `<div>${escapeHtml(input.upstreamVersionLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      // 淡出时长与样式里的 transition 保持一致，单点定义在脚本内。
      const CLOSE_FADE_MS = 160;
      let closing = false;
      const closeWindow = () => {
        if (closing) {
          return;
        }
        closing = true;
        const reducedMotion =
          window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reducedMotion) {
          window.close();
          return;
        }
        // 先让内容淡出，过渡结束后再销毁窗口；顺序反了就会“内容先消失、动画再走”。
        document.body.classList.add("is-closing");
        window.setTimeout(() => window.close(), CLOSE_FADE_MS);
      };
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}
