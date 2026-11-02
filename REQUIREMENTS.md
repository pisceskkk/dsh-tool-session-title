# 需求：让 agent 主动管理会话标题（DSH 插件）

状态：需求基线（Lead 整理）
目标读者：方案设计 agent（Opus）、实现 agent（DSV4.1-Flash）、代码检视 agent（Codex 6.1 Sol）

---

## 1. 背景

DSH 的会话标题（`session/title` 事件）有三个来源：确定性 fallback、模型 provider（默认 `first-prompt`，可选 `all-prompts`，即 Plugins 里的 Conversation-following titles）、用户显式 `rename()`。

现状：**模型侧没有任何读写标题的工具**。会话标题是 log-only，不进入模型上下文；重命名只有用户侧 UI / Host RPC。

用户希望在对话中由 agent 主动把会话名改成约定格式，规则如下（原文）：

> If a session/thread rename tool (e.g., set_thread_title) is available in your toolset, set the title once the primary goal is clear; if no such tool exists, skip silently: `<type>(<scope>[, <scope>]): <short Chinese subject or keywords>` (max 50 chars, no trailing period)
>
> Types: feat, bugfix, docs, style, refactor, perf, test, chore, review (PR review), spike (investigation/planning), misc.
> Scope & Subject: 1–2 concise module/feature keywords; concrete Chinese subject keeping technical terms/abbreviations in English (e.g., `feat(auth): 支持 SSO`, `perf(DSv4, PCP): 优化多流重叠`).
> Stability: Set once per main theme. Update only on explicit user request or a sustained shift in the primary goal; ignore minor detours.

因此需要交付一个 DSH 插件，同时提供 **工具** 与 **提示词段**。

## 2. 目标

- G1 agent 能通过一个工具把**当前会话**的标题设置为规则格式。
- G2 规则以 system prompt section 的形式随插件提供，只在工具存在时生效。
- G3 插件可安全安装到 `~/.dsh/profiles/desktop`，失败可一键回滚，不破坏 DSH Desktop 启动。
- G4 不改变 DSH 现有自动标题行为之外的任何东西；agent 设置后标题稳定（pin），符合 "set once"。

## 3. 功能需求

| 编号 | 需求 | 说明 |
|---|---|---|
| F1 | 工具 `set_session_title(title: string)` | 重命名**调用方** session；返回 `previous`（可为 null）与 `current` |
| F2 | 只对当前会话生效 | 通过 `exec.agent.session` 取得；不接受 sessionId 参数，避免越权改其他会话 |
| F3 | 幂等 | 请求标题与当前标题完全相同 → 不追加事件，直接返回 `unchanged: true` |
| F4 | 长度校验 | 按 UTF-8 字节校验 `maxTitleBytes`（当前 80）；超限**报错并给出实际字节数**，由模型自行改短，不静默截断 |
| F5 | 子会话策略 | 默认跳过：`session.header.parentSession !== undefined` 时返回结构化错误，不修改标题（见决策 D3） |
| F6 | 提示词段 | 由同一插件注册 `ctx.systemPrompt.section`，文本为规则的中文落地版（含工具名、格式、类型枚举、稳定性和 80 字节约束） |
| F7 | 只读能力（可选） | 提供 `get_session_title()` 返回当前标题与来源，便于模型自校准（见决策 D2） |
| F8 | 失败可诊断 | 服务缺失、会话非 live、空标题等错误带稳定错误码/文案，不抛出未捕获异常拖垮 turn |

## 4. 非功能需求

| 编号 | 需求 |
|---|---|
| N1 | 插件为纯 ESM，导出 `name`、`inject`、`apply(ctx, config)`；不得依赖 profile 中不存在的包（只使用 `@deepseek-ai/dsh-tools` 这类应用内置包） |
| N2 | 不新增运行时依赖；不联网；不写 profile 以外的路径 |
| N3 | 工具描述与提示词段合计 token 开销可控（提示词段 ≤ 400 字） |
| N4 | 安装脚本具备备份、幂等、可回滚；回滚 = 恢复 `cordis.patch.yml` 备份 + 删除包目录 |
| N5 | 提供可在**纯 Node（无 DSH 进程）**下运行的冒烟测试：用 `module.registerHooks` 把 `@deepseek-ai/dsh-tools` 映射到本地 stub，断言插件导出、工具 schema、提示词段文本、`execute` 行为（正常/幂等/超长/子会话） |
| N6 | 所有产物带 README（安装、卸载、验证、已知限制） |

## 5. 已验证的 DSH API 事实（实现必须以这些为准，不要臆造）

1. **插件模块形态**（参照 `@deepseek-ai/dsh-tool-todo`）：
   ```js
   export const name = 'tool-session-title';
   export const inject = ['tools', 'systemPrompt', 'sessionTitle'];
   export function apply(ctx, config) { ... }
   ```
   `Config` 可选（schemastery），本次可不提供配置。
2. **工具注册**：`ctx.tools.register(defineTool({ name, description, parameters, output, execute, presentCall? }))`，`defineTool` 来自 `@deepseek-ai/dsh-tools`。
3. **`parameters` 是 DSH 自定义 schema spec**，不是 zod、也不是标准 JSON Schema：形如
   ```js
   parameters: { title: { type: 'string', required: true, description: '...' } }
   ```
   对象需 `type:'object'` + `properties` + `additionalProperties:false`。
4. **`output`**：`{ schema: <JSON Schema 子集>, render: (args, value) => [{ type: 'text', text }] }`；schema 只支持 type/oneOf/properties/required/additionalProperties/items/enum/const + 注解。
5. **提示词段**：`ctx.systemPrompt.section({ name, order, text })`。`ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY')` 只接受内置枚举名；外部贡献可以直接给有限数字（建议 2300 附近）。
6. **标题服务**（`@deepseek-ai/dsh-session-title`，ctx key `sessionTitle`）：
   - `ctx.sessionTitle.get(session)` → `{ title, source: { kind: 'fallback' | 'provider' | 'user' }, eventSeq, ... }` 或 `undefined`
   - `ctx.sessionTitle.rename(session, title)` → 同上结构；空标题抛 `SessionTitleInvalidError`；会话不在当前 store 时抛普通 Error
   - `rename()` 写入 `source.kind === 'user'`，**pin 住标题**：之后 all-prompts 自动更新不再覆盖，直到 `refresh()`
   - 标题写入时按 `maxTitleBytes` 做 UTF-8 安全截断，超长不会报错 → 因此工具必须自己先校验
7. **当前 profile 配置**：`fallbackMaxWords: 5`、`fallbackMaxBytes: 40`、`maxTitleBytes: 80`；已启用 Conversation-following titles（all-prompts provider）。
8. **会话对象**：`exec.agent.session`；`session.header.parentSession` 非空表示子会话；`session.id` 为 SessionId。
9. **挂载机制**：profile 是 pnpm workspace（`nodeLinker: hoisted`），插件包放 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/<pkg>/`；`cordis.patch.yml` 顶层数组里 `- insert:` 追加 `{ id, name }`。**加载失败会导致 host 启动失败**（历史崩溃日志已证实），因此必须可回滚。
10. **生效时机**：profile 在 host 启动时组装；安装后需要重启 DSH Desktop（或触发 profile 重载）才生效。

## 6. 决策点（设计 agent 必须逐条给出结论与理由）

- D1 工具名：`set_session_title` / `set_thread_title` / `rename_session`？需与提示词段一致（用户原规则写的是 `set_thread_title`，但 DSH 术语是 session）。
- D2 是否提供 `get_session_title`？若不提供，如何让模型在上下文压缩后不重复设置？
- D3 子会话：跳过 / 允许 / 可配置？默认建议跳过。
- D4 超长：报错（推荐）还是截断？错误文案如何让模型可自助修正。
- D5 幂等：同标题 no-op 是否改变返回值语义。
- D6 提示词段文本（中文落地版）与 `order` 取值。
- D7 安装形态：直接改 live profile（有风险）还是提供 `install.ps1` + 备份 + 自检，由用户执行？
- D8 与自动标题的关系：是否需要在提示词段里说明"设置后自动标题停止"。

## 7. 交付物

```
session-title-tool/
├─ REQUIREMENTS.md          # 本文件
├─ design/DESIGN.md         # Opus 产出：架构、决策、文件清单、风险
├─ src/                     # 插件包源码（package.json / lib/index.js / README.md）
├─ test/smoke.mjs           # 纯 Node 冒烟测试（含 dsh-tools stub）
├─ scripts/install.ps1      # 安装到 profile（备份 + 幂等 + -Rollback）
└─ review/REVIEW.md         # Codex 产出：问题清单与结论
```

## 8. 验收标准

- A1 `node --check` 通过所有 JS 文件。
- A2 `node test/smoke.mjs` 全绿，覆盖：导出形状、工具 schema、提示词文本、正常设置、幂等、超长拒绝、子会话拒绝、服务缺失。
- A3 安装脚本在 `-WhatIf`/dry-run 下打印将执行的操作；真实执行前备份 `cordis.patch.yml`。
- A4 代码 review 无 **blocking** 问题；non-blocking 问题记录在案。
- A5 产物不含硬编码用户路径（脚本内用 `$env:USERPROFILE` 推导）。

## 9. 范围外

- 不实现 `refresh()` / 解除 pin 的工具（可作为后续扩展）。
- 不修改 DSH 本体（app.asar）。
- 不处理 Web UI 的按钮/快捷键（已有 rename）。
- 不改 `maxTitleBytes`（若要支持 50 个汉字再单独提）。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 插件语法/依赖错误导致 Desktop 起不来 | 冒烟测试 + 安装前备份 + 一键回滚脚本 |
| `rename` pin 掉自动标题，用户以为自动标题坏了 | 提示词段与 README 明确说明；保留 `refresh` 的后续扩展位 |
| 80 字节上限与 50 字符规则冲突 | 工具按字节拒绝并回报字节数；提示词段写"≤25 个汉字或 ≤80 字节" |
| 模型重复设置标题 | 幂等 + `previous` 返回值；可选 `get_session_title` |
