---
name: visual-output
description: Rich inline output conventions for the ZCode client renderer. Load when showing deliverables, demos, or verification results to the user, when you have (or can take) several screenshots, or when a diagram or flow explains better than prose. Covers the swipeable image gallery, <details> folding, and mermaid-first explanations.
---

# Visual output

The client renders rich inline content from plain Markdown conventions. Prefer these over long prose when presenting results; never write raw HTML/CSS/JS for layout.

## Gallery (multiple screenshots)

Output 2+ consecutive image lines, one per line, nothing else in between. The renderer groups them into a horizontal swipeable gallery with a lightbox.

```markdown
![Login page](screenshots/login.png)

![Dashboard](screenshots/dashboard.png)

![Settings](screenshots/settings.png)
```

- Take screenshots with `agent-browser screenshot` (or the built-in browser-use `screenshot` tool) into a workspace directory, then reference workspace-relative paths.
- Alt text is the slide label; keep it short and human-readable.
- A single image stays standalone; only consecutive image lines group.

## Folded sections (details)

Put secondary material — long lists, full logs, env dumps, mechanical diffs — inside `<details>`, so the main answer stays scannable.

```html
<details>
<summary>Full test output (128 passed)</summary>

- `src/auth/login.ts` +42
- `src/router.ts` −7

</details>
```

Hard rules, or the content will not render:

1. `<summary>` must be the first child of `<details>`; its text is the card title.
2. Blank lines around the inner Markdown are mandatory. Without them the content is treated as raw text, not Markdown.
3. Never hide must-act information (errors, permission requests, next steps) inside a fold.
4. `<details open>` renders expanded by default; plain `<details>` starts collapsed.

Wrong — inner Markdown is swallowed as text:

```html
<details>
<summary>Files</summary>
- `a.ts`
- `b.ts`
</details>
```

## Mermaid first

For flows, architecture, state machines, and timelines, output a ` ```mermaid ` diagram instead of nested prose lists. Keep node labels short.
