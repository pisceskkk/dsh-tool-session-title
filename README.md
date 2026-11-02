English | [中文](README.zh-CN.md)

# dsh-tool-session-title

[![CI](https://github.com/pisceskkk/dsh-tool-session-title/actions/workflows/ci.yml/badge.svg)](https://github.com/pisceskkk/dsh-tool-session-title/actions/workflows/ci.yml)

A DeepSeek Harness (DSH) plugin that enables the AI agent to actively manage its own session title.

## The Problem

In vanilla DeepSeek Harness, session titles can only be generated automatically by the model provider or manually renamed by users through the GUI. The model has no tools to inspect or update the session title. Furthermore, session title events in DSH are `log-only`—they are recorded in event logs but are never injected into the model's conversation context. Consequently, the agent cannot perceive its current title, cannot align it with the task's primary goal, and cannot calibrate itself across context compactions without dedicated tools.

## What It Provides

| Component | Kind | Description |
|---|---|---|
| `set_session_title(title)` | Tool | Sets the title of the current session. Returns `{ unchanged, previous, current }`. Once set, the title is **pinned** (`source: user`), preventing automatic provider titles from overwriting it. |
| `get_session_title()` | Tool | Returns `{ title, source }` (`fallback` / `provider` / `user` / `null`) for the current session, enabling self-calibration and inspection. |
| `tool:set_session_title` | System prompt section | Teaches the agent the `<type>(<scope>): <subject>` convention, byte/character limits, once-per-theme usage, and skipping child sessions. Registered at order `2305` and rendered only when the tool is visible. |

## Behavior and Guarantees

- **Current Session Scoped**: Always operates strictly on the calling agent's session (`exec.agent.session`). It does not accept arbitrary session IDs and cannot modify other sessions.
- **Child Session Rejection (`E_CHILD_SESSION`)**: Child sessions (subagents where `session.header.parentSession` is present) are explicitly rejected. Subagents do not participate in session naming.
- **Strict Byte Limit Check (`E_TITLE_TOO_LONG`)**: Reads the runtime byte limit from `ctx.sessionTitle.config.maxTitleBytes` (defaults to 80). If the title exceeds the UTF-8 byte limit, the call fails with `E_TITLE_TOO_LONG` and reports both the actual and maximum byte counts. The title is never silently truncated, allowing the agent to shorten it and retry.
- **Error Codes**: Throws structured `[E_CODE] message` errors, surfaced to the model as `isError` tool results:
  - `E_SERVICE_UNAVAILABLE`: `ctx.sessionTitle` is missing.
  - `E_NO_AGENT`: Invoked outside an active agent session (`exec.agent.session` missing).
  - `E_CHILD_SESSION`: Called from a child/subagent session.
  - `E_EMPTY_TITLE`: `title` is not a string, empty, whitespace-only, or sanitizes to nothing (`SessionTitleInvalidError`).
  - `E_TITLE_TOO_LONG`: UTF-8 byte length exceeds `maxTitleBytes`.
  - `E_SESSION_NOT_LIVE`: Session is not live in the store (`rename()` throws).
- **Idempotency**: Submitting a title identical to the current one returns `{ unchanged: true, current: title }` without emitting events, changing `source`, or invoking `rename()`.
- **Pin Semantics**: Renaming sets `source: user`. DSH treats user titles as pinned; automatic title generation stops permanently for that session unless explicitly reset via `refresh()` (not exposed by this plugin).

## Installation

Requirements: Windows with PowerShell 5.1 or PowerShell 7+. The default profile path is `%USERPROFILE%\.dsh\profiles\desktop`.

```powershell
# 1. Dry run: preview planned actions without writing any files
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# 2. Install: backs up cordis.patch.yml, stages package copy, and updates patch file atomically
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 3. Rollback: restores the latest safe backup and removes the package directory
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Rollback
```

> **Note**: You must **restart DSH Desktop** after installing or rolling back for changes to take effect.

### Installer Parameters

- `-WhatIf`: Dry run. Validates preflight conditions and prints planned actions without modifying files.
- `-Rollback`: Restores the newest safe `cordis.patch.yml.bak.*` and removes the package directory. Refuses to delete anything if no safe backup exists.
- `-Force`: Refreshes an existing package directory instead of skipping the copy.
- `-ProfilePath <path>`: Specifies a custom DSH profile path (defaults to `%USERPROFILE%\.dsh\profiles\desktop`).
- `-SourcePath <path>`: Specifies a custom plugin source directory (defaults to `..\src`).

## Verification

No active DSH instance is required for local testing:

```powershell
# Syntax validation
node --check src/lib/index.js
node --check test/smoke.mjs

# Run the 30-case smoke test suite
node test/smoke.mjs
```

`test/smoke.mjs` intercepts `@deepseek-ai/dsh-tools` via Node's `module.registerHooks` using an in-memory stub. It captures raw author definitions before runtime compilation and lints them against author-schema DSL rules. The 30 tests cover:
- Tool definitions and parameter/output schemas.
- Prompt section registration (order `2305`) and dynamic visibility gating.
- Setting titles, byte length limits, empty title validation, idempotency, and child session rejection.
- Absence of `sessionTitle` or `agent.session`.
- Reading titles and source kinds (`fallback`, `provider`, `user`, or `null`).
- Installer correctness: `-WhatIf` zero-write guarantee, idempotent re-runs, safe rollback, sibling key (`after:`) and comment preservation, atomic staging swap, rollback rejection without safe backups, and UTF-8 encoding fidelity without BOM under Windows PowerShell 5.1.

### Continuous Integration

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on `windows-latest` with Node 24. It executes:
1. Syntax checks on `src/lib/index.js` and `test/smoke.mjs`.
2. The full 30-case smoke test suite (`node test/smoke.mjs`).
3. An installer dry-run verification (`install.ps1 -WhatIf`) on a temporary profile to prove zero filesystem mutations.

## Known Limitations

- **Irreversible Pinning**: Setting a title pins it (`source: user`). Automatic title updates cease permanently for that session. This version does not provide a `refresh` tool.
- **80-Byte Ceiling**: Roughly 25 Chinese characters. For CJK text the 80-byte ceiling binds first, so the 50-character cap in the convention rarely comes into play.
- **pnpm Pruning**: Profile dependencies are managed by pnpm with `nodeLinker: hoisted`. Adding or removing plugins through the DSH UI can trigger `pnpm install`, which may remove hand-installed package directories and cause startup failures. If this occurs, re-run `install.ps1`, or run `install.ps1 -Rollback` if the application fails to launch.
- **Child Sessions Skipped**: Child agent sessions cannot set or change titles (`E_CHILD_SESSION`).

## Repository Structure

```
├── .github/workflows/ci.yml  # CI workflow: syntax, smoke tests, and dry-run check
├── design/                   # Design specifications, DSL rules, and review notes
│   ├── DESIGN.md             # Baseline design and architectural decisions
│   ├── FIX-NOTES.md          # Review fix logs
│   ├── LEAD-NOTES.md         # Architecture review and lead feedback
│   └── SCHEMA-RULES.md       # DSH author-schema DSL constraints
├── scripts/
│   └── install.ps1           # Transactional installer and rollback script (PS 5.1 / 7+)
├── src/
│   ├── lib/
│   │   └── index.js          # Plugin entry point: tool definitions and prompt section
│   ├── package.json          # Plugin manifest (@deepseek-ai/dsh-tool-session-title)
│   └── README.md             # Package-level documentation
├── test/
│   └── smoke.mjs             # 30-case standalone smoke test and schema linter
├── LICENSE                   # MIT License
└── REQUIREMENTS.md           # Requirements baseline and verified DSH API facts
```

## Design Documentation

- [REQUIREMENTS.md](REQUIREMENTS.md) — Functional requirements, acceptance criteria, and verified DSH runtime APIs.
- [design/DESIGN.md](design/DESIGN.md) — Architecture, execution pipeline, and design decisions D1–D8.
- [design/SCHEMA-RULES.md](design/SCHEMA-RULES.md) — Hard author-schema rules for DSH `defineTool`.
- [design/LEAD-NOTES.md](design/LEAD-NOTES.md) — Architectural feedback and review amendments.
- [design/FIX-NOTES.md](design/FIX-NOTES.md) — Specific issues addressed during implementation.

## License

[MIT](LICENSE) © 2026 Qiu Chunshuo
