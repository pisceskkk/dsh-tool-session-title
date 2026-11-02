# @deepseek-ai/dsh-tool-session-title

A DSH plugin that lets the agent **name its own session**, and teaches it the naming convention through one system-prompt section.

| Piece | What it does |
|---|---|
| tool `set_session_title(title)` | Renames the **calling** session, returns `{ unchanged, previous, current }` |
| tool `get_session_title()` | Returns `{ title, source }`, where `source` is `fallback` / `provider` / `user` |
| prompt section `tool:set_session_title` | The `<type>(<scope>): <subject>` rule, order **2305**, injected only where the tool is visible |

Setting a title writes a `user`-source title, which **pins** it: the automatic (provider) title stops updating until something calls `refresh()`. This plugin intentionally does not expose `refresh()`.

---

## 安装

Requirements: DSH Desktop installed, and a profile at `%USERPROFILE%\.dsh\profiles\desktop`.

```powershell
# 1. Preview every action; writes nothing.
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# 2. Install (backs up cordis.patch.yml, copies src/, inserts the entry first in the list).
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 3. Restart DSH Desktop. The plugin only loads at host start.
```

Parameters:

| Parameter | Meaning |
|---|---|
| `-WhatIf` | Validate and print the plan; change nothing |
| `-Rollback` | Restore the newest **safe** `cordis.patch.yml.bak.*` and delete the package directory. Refuses (exit 1) when no safe backup exists — see below |
| `-Force` | Refresh an existing package directory (staged swap; the old copy is kept until the new one is in place) |
| `-ProfilePath <path>` | Target another profile (default `$env:USERPROFILE\.dsh\profiles\desktop`) |
| `-SourcePath <path>` | Copy another plugin source (default: this repository's `src/`) |

What the script does, in order:

1. Checks that the profile, `cordis.patch.yml`, `node_modules\@deepseek-ai\`, and the plugin source exist.
2. Reads the patch as explicit UTF-8 (no BOM) and computes the new text **without writing**. The entry goes on the line immediately after the first `- insert:` key, as its first child:
   ```yaml
   - id: tool-session-title
     name: "@deepseek-ai/dsh-tool-session-title"
   ```
   The script never looks for the end of the block, so sibling keys (`after:`), comments and multi-entry lists are untouched. A layout it cannot prove safe (no `- insert:` key, an inline `[]`, tabs) is a hard failure: exit 1, nothing written.
3. Backs up the patch file to `cordis.patch.yml.bak.<stamp>` (newest **5** kept) and verifies the copy byte-for-byte.
4. Stages `src/` into a sibling staging directory, verifies `package.json` + `lib/index.js`, moves any existing package to a `.old` directory, activates the staging directory, then commits the patch by atomic replace.
5. If any step fails, the patch is restored from the backup, the new directory is removed and the `.old` copy is moved back.

The script is idempotent and safe to re-run (PowerShell 5.1 compatible). A re-run of a complete install changes nothing — no copy, no backup, no patch write.

## 卸载 / 回滚

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Rollback -WhatIf   # preview
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Rollback
# Then restart DSH Desktop.
```

Rollback is deliberately conservative. It restores the newest backup that no longer registers this plugin and then removes the package directory:

- **No `cordis.patch.yml.bak.*` at all** → prints `No backup found`, exits **1**, and deletes nothing. Removing the package while the patch might still register it is the one thing that can stop DSH from starting.
- **Newest backup still contains `- id: tool-session-title`** (for example a copy taken after an install) → that backup is skipped for an older safe one; if none is safe, it exits **1** and deletes nothing.
- **Safe backup found** → the patch is restored (validated in memory first), then the package directory is renamed out of the way and deleted.

Manual equivalent — only after you have removed the registration by hand:

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
# 1. delete the `- id: tool-session-title` / `name:` pair from $p\cordis.patch.yml
# 2. then:
Remove-Item -Recurse -Force "$p\node_modules\@deepseek-ai\dsh-tool-session-title"
```

**Emergency**: if DSH Desktop will not start after installing, run `-Rollback`, then restart. A plugin that fails to load can block host startup.

## 验证

Run these from the repository root (no DSH process needed):

```powershell
$node = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

& $node --check src\lib\index.js
& $node --check test\smoke.mjs
& $node test\smoke.mjs          # expect: ✓ 27 tests passed, exit 0
```

PowerShell syntax check for the installer:

```powershell
powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('.\scripts\install.ps1',[ref]$null,[ref]$errs); $errs"
```

After installing and restarting, verify in a chat:

1. `/` tool list shows `set_session_title` and `get_session_title`.
2. Ask the agent to set a title; the session title changes and stays.
3. `get_session_title` reports `source: "user"`.

### What the smoke test covers

T1–T12 (design): export shape, schemas, section name/order, conditional section text, normal set, idempotency, byte limit, empty title, child session, missing service, get with/without a title. T13–T15 (lead notes): `E_NO_AGENT`, config-driven `maxTitleBytes`, section text toggling, ≤400 chars and every original naming constraint (≤80 bytes, ≤50 chars, no trailing period, `pin`, set once per theme, no child titles, silent skip).

Installer regressions: T16 `-WhatIf` writes nothing, install anchors the entry and is idempotent, `-Rollback` restores. T21 sibling key (`after:`) layout. T22 comment layout (before the block, between key and first item, inside the item, after the block). T23 rollback without any backup. T24 rollback when the only backup still registers the plugin. T25 `-Force` with a missing/incomplete source keeps the old package and patch. T26 UTF-8 fidelity under Windows PowerShell 5.1 (Chinese comments, paths and prompts survive byte-for-byte, no BOM). T27 unsafe layouts (`insert: []`, no insert block) fail without touching the patch, and a comment mentioning the id is not treated as a registration.

T17: linter self-test with known-bad schemas. T18: linter over both tools' `parameters` and `output.schema`. T19–T20: non-live rename, and proof the `registerHooks` `defineTool` stub actually captured the plugin's calls (no false green, no test stub in `src/`).

## 已知限制

- **需要重启生效.** The profile is assembled at host start; installing, rolling back, or editing the plugin does nothing until DSH Desktop restarts.
- **pnpm 可能清理手装目录.** The profile is a pnpm workspace (`nodeLinker: hoisted`). Adding or removing plugins in the DSH GUI can trigger `pnpm install`, which prunes directories absent from `package.json` — including this one. The host then fails to start. **After installing, do not change the plugin list inside DSH**; if you did, re-run `install.ps1` to restore.
- **pin 语义.** Setting a title pins it (`source.kind === "user"`). Automatic titles stop updating for that session. This plugin has no unpin tool; the model is told to set the title once per main theme.
- **80 字节上限.** The limit is read at call time from `ctx.sessionTitle.config.maxTitleBytes` (currently **80**), falling back to `80`. Titles are rejected, **not truncated**, when over the limit — 80 bytes is roughly 25 Chinese characters. The prompt text states 80 bytes explicitly; if the profile changes `maxTitleBytes`, edit `PROMPT_TEXT` in `src/lib/index.js` and re-install.
- **子会话不设标题.** Sessions with `header.parentSession` are rejected with `E_CHILD_SESSION`.
- **`order: 2305`** was chosen because `SECTION_ORDERS.TOOL_SESSION_QUERY` already occupies 2300. A future DSH release could take 2305; re-check after upgrades.
- **`execute` errors** are thrown as `[E_CODE] message`. DSH surfaces them to the model as `isError` tool results; if a future runtime wraps them differently, the model still sees the code.
- **`@deepseek-ai/dsh-tools` 是静态导入.** `lib/index.js` starts with `import { defineTool } from '@deepseek-ai/dsh-tools'`. There is no lazy loader, no async `apply()`, and no test stub in `src/`: the smoke test redirects the bare specifier with `module.registerHooks`.

## 错误码

| Code | Condition |
|---|---|
| `E_SERVICE_UNAVAILABLE` | `ctx.sessionTitle` missing (checked first) |
| `E_NO_AGENT` | `exec.agent` undefined (not an agent call) |
| `E_CHILD_SESSION` | `session.header.parentSession` set (non-null) |
| `E_EMPTY_TITLE` | `title` not a string, empty, whitespace-only, or normalizes to nothing |
| `E_TITLE_TOO_LONG` | UTF-8 bytes > `maxTitleBytes` (message includes both numbers) |
| `E_SESSION_NOT_LIVE` | `rename()` threw |

Validation order, exactly as implemented: **`ctx.sessionTitle` present → `exec.agent.session` present → child session → empty title → byte limit → idempotency → `rename()`**. Because the service check comes before the agent check, a call with neither reports `E_SERVICE_UNAVAILABLE`. A malformed call from the real runtime (missing or non-string `title`) is rejected by the runtime's own argument validation (`ToolArgsError`) before `execute` runs; `E_EMPTY_TITLE` covers empty or whitespace-only strings.
