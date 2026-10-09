<p align="center">
  <img src="icon-source-1024.png" alt="YCode" width="128" height="128" />
</p>

<h1 align="center">YCode</h1>

<p align="center"><strong>A community fork of ZCode</strong><br />Self-hosted · Open source · Built for developers — staying close to the official experience while serving multi-provider setups and everyday coding better</p>

<p align="center">
  <img src="https://img.shields.io/badge/based_on-ZCode-blue?style=flat-square" alt="Based on ZCode" />
  <img src="https://img.shields.io/badge/Desktop-Electron-47848F?style=flat-square&logo=electron&logoColor=9FE2BF" alt="Desktop" />
  <img src="https://img.shields.io/badge/Web-React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="Web" />
  <img src="https://img.shields.io/badge/Agent_CLI-Terminal-111111?style=flat-square" alt="Agent CLI" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-2ea44f?style=flat-square" alt="Apache-2.0" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#release-notes">Release notes</a> ·
  <a href="#philosophy">Philosophy</a> ·
  <a href="#multi-provider-collaboration">Providers</a> ·
  <a href="#opencode-integration">OpenCode</a> ·
  <a href="#deepseek-balance">DeepSeek</a> ·
  <a href="#web-and-remote-control">Web & Remote</a> ·
  <a href="#experience-and-performance">Experience</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#credits-and-license">Credits</a>
</p>

---

YCode is a community fork of [ZCode](https://github.com/zai-org/ZCode), and a **self-hosted AI coding workspace**. Desktop, Web, and the terminal Agent are all open source in this repository: code, build pipeline, and session data stay on your own machine, and model requests go to the provider endpoints you configure. Requests using official Coding Plan models are forwarded through the official gateway; data flows and boundaries are documented in [NOTICE.md](NOTICE.md).

On top of the upstream trunk, YCode extends capabilities that used to serve only the official provider to every provider you actually use, adds development-centered features, connects Web and LAN-based phone remote control, and keeps fixing upstream issues while improving rendering and interaction performance.

## Download

The first stable release [v4.0](changelogs/v4.0.md) is out (based on upstream ZCode 3.14.0). Installers live on [GitHub Releases](https://github.com/CasingAI/YCode/releases/latest):

| Platform | Arch        | Installer                                                                                                           |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| macOS    | Apple chips | [YCode-4.0.140-mac-arm64.dmg](https://github.com/CasingAI/YCode/releases/download/v4.0/YCode-4.0.140-mac-arm64.dmg) |
| macOS    | Intel       | [YCode-4.0.139-mac-x64.dmg](https://github.com/CasingAI/YCode/releases/download/v4.0/YCode-4.0.139-mac-x64.dmg)     |
| Windows  | x64         | [YCode-4.0.138-win-x64.exe](https://github.com/CasingAI/YCode/releases/download/v4.0/YCode-4.0.138-win-x64.exe)     |

No prebuilt Linux package yet — run from source as described under Quick start. The Release page is the source of truth for actual artifacts.

## Release notes

- One file per release under [CHANGELOG.md](CHANGELOG.md); the latest is [v4.0 — 2026-10-08](changelogs/v4.0.md) with 67 items that differ from the official build, screenshots included.
- The sections below are an overview of everyday features; the changelog is the complete record of how v4.0 differs from upstream (plan mode, session timeline, task management, goals, permission tiers, context compaction, storage panel, narrow-screen layout, and more).

## Philosophy

| Principle              | What it means                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Close to upstream      | Default experience stays consistent with official ZCode, no breaking changes, easy to diff and sync with upstream                     |
| Multi-provider support | No new providers added; instead, capabilities that only served the official provider are adapted per provider, by each one's real API |
| Dev-first              | Features are designed around writing code, fixing real blockers in coding workflows first, not stacking generic features              |
| Smoother details       | Small UX improvements, legacy-issue fixes, and performance work make daily use better than the official build                         |
| Open and self-hosted   | Full build pipeline and runtime are open source; build, audit, and modify it yourself, code and data stay in your environment         |

## Multi-provider collaboration

ZCode already supports a dozen-plus model providers. YCode's focus is not adding more providers, but **making the supported ones actually work together** — extending capabilities previously reserved for the official provider to every provider you use.

The most visible example is **quota visibility**. In the official build, Z.AI / BigModel Coding Plan shows remaining quota and reset time in the sidebar and composer; switch to another known provider and you only get a model name, with no idea how much is used or left. Quota is exactly the information that decides "should I switch models or wait for the next window". YCode fills this gap per each provider's real API.

Other capabilities extended to all providers:

**Three protocols natively adapted**, not simple endpoint rewrites:

- `anthropic-messages` → Anthropic-style endpoints
- `openai-responses` → OpenAI Responses endpoints
- `openai-chat-completions` → OpenAI-compatible gateways

**Built-in providers**: Z.AI, BigModel / Zhipu Open Platform, Moonshot / Kimi, MiniMax, DeepSeek, Qwen (China / Global), Xiaomi MiMo, OpenAI, Anthropic, xAI, OpenRouter, OpenCode.

**Custom providers**: freely configure API key, `baseUrl`, custom headers, protocol type, and model list to plug in self-hosted gateways or third-party compatible endpoints.

**Per-model network policy**: each model can independently follow the global proxy, use the YCode network-settings proxy, use the system proxy, or force direct connection (`default` / `proxy` / `system` / `direct`). Different providers often live at different network locations, so they can mix without interfering; the setting only affects that model's inference requests, not Bash, MCP, WebFetch, or other network egress.

**Model & context management**: per-model enable/disable, context window, input/output capabilities, tool call, JSON Schema output, reasoning tiers, and max output length; query remaining context mid-conversation and ask the model to compact proactively.

## OpenCode integration

YCode integrates closely with [OpenCode](https://opencode.ai), covering the full path from onboarding to usage visibility.

- **Built-in templates**: Go and Zen endpoints × Chat Completions / Messages / Responses protocols (6 templates), with a dedicated OpenCode group, icon, and copy in settings — never mixed with "other providers".
- **Plan quota lookup**: reads usage via the OpenCode Console API across rolling 5-hour, weekly, and monthly windows; credentials are stored per-provider by the local credential service, queries only originate from the Host process, and the renderer reads via RPC.
- **Where it shows**: the OpenCode card in settings and the context popover in the composer; the entry disappears when you switch to another provider, and no network request is made when no credential is configured.
- **Request attribution**: recognizes OpenCode endpoints and attaches session-identifying request headers so usage maps back to sessions.

## DeepSeek balance

[DeepSeek](https://platform.deepseek.com) has no subscription quota — account usage is simply the open-platform balance. YCode surfaces that balance in the app, in the same place official plan quota appears.

- **No extra credential**: balance lookup reuses that provider's own API key, no new credential storage; no request is made when the key is empty.
- **Where it shows**: the DeepSeek card in settings and the context popover in the composer; the entry disappears when you switch to another provider.
- **Honest units**: DeepSeek reports no total, so there is no "remaining percentage" or progress bar — only the signed amount in its currency (e.g. `¥19.54`); on lookup failure the last known balance is kept with a notice instead of showing 0.

## Web and remote control

Upstream's Web build only exists as a CLI distribution: `zcode --web` runs, but the desktop client has no entry point — if you don't dig through docs, it effectively doesn't exist. YCode closes that gap and makes Web genuinely usable.

- **One-click start on desktop**: launch LAN access directly from the desktop app, no CLI distribution, no manual Web build.
- **Phone browser connects to the same Host**: a phone or another computer's browser reaches back to the desktop over LAN, reusing the desktop's running Host, workspace, and Agent session instead of starting a second server.
- **Continuity design**: fixed port and token auth, long-lived cookie after first token visit, automatic recovery on restart; reconnects preserve page, tasks, drafts, and navigation; commands with side effects reconcile by `commandId` instead of blind replay.
- **No external relay**: no relay, pairing codes, or tunnels — the connection stays inside your own LAN.

## Experience and performance

A batch of development-experience changes, keeping official interaction logic intact.

| Area             | Changes                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| UI & density     | Nav bar off by default for a large performance win; denser Chat UI; simpler mode switching; better model name display; K-unit context |
| Process display  | Cursor-style collapsed process; better Thinking rendering; better call-trace display; better Plan cards                               |
| Modes & planning | Ask read-only Q&A mode; better mode communication with the model; better Plan long-term memory                                        |
| Tools & config   | Bash tool Description support (incl. Chinese); experimental feature flags; skip init-config phase on startup                          |
| Remote & network | Per-model proxy policy; Web entry and phone remote control covered in the previous section                                            |

## Fixed issues

Confirmed and fixed in upstream code:

- [x] Conversation sort order used the wrong timestamp
- [x] AskUserQuestion showed "no answer provided" even when answered
- [x] Thinking content missing under the Responses protocol
- [x] Wrong Thinking elapsed-time display

## Quick start

### Requirements

| Dependency                    | Version   | Notes                                     |
| ----------------------------- | --------- | ----------------------------------------- |
| Git                           | recent    | required                                  |
| [mise](https://mise.jdx.dev/) | recent    | versions pinned in [mise.toml](mise.toml) |
| Node.js                       | `24.14.0` | desktop & Agent runtime                   |
| pnpm                          | `10.33.2` | workspace package management              |

### Start the desktop app

```bash
# First run or after code updates: rebuild prebuilt artifacts
mise run start-build

# Start with existing artifacts
mise run start
```

Both tasks write data to an isolated dev directory (`ZCODE_DATA_BASE_DIR`, default `~/.zcode-dev-home`) and never touch production data.

### Daily development

```bash
mise run dev                       # desktop, isolated local test env
mise run dev-desktop-prod          # desktop, production service config
mise run dev-web                   # web + backend

pnpm typecheck                     # typecheck
pnpm lint                          # lint
pnpm fmt:check                     # format check
pnpm architecture:check --changed  # architecture boundary check
```

Full init, packaging, and release flows follow upstream docs: [ZCode repository README](https://github.com/zai-org/ZCode#readme). Feature and interaction design decisions are recorded in [docs/specs/](docs/specs/).

## Roadmap

- [ ] Integrate ZCode Stats
- [ ] Add file editor capability
- [ ] Chat search for AI
- [ ] Fix edited messages not using the latest model config

## Credits and license

- Upstream project: [zai-org/ZCode](https://github.com/zai-org/ZCode) — thanks for open-sourcing the desktop, Web, and Agent runtime.
- This repository follows [Apache-2.0](LICENSE). Feature scope, data handling, and third-party declarations live in [NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- AI-generated content may contain errors or omissions; verify important actions yourself and keep recoverable backups.
