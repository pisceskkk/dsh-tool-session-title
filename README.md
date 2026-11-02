# dsh-tool-session-title

让 **agent 自己管理会话标题** 的 DeepSeek Harness（DSH）插件。

DSH 原生只有"自动生成标题"和"用户在 UI 里重命名"两条路径，模型侧没有任何读写标题的工具。本插件补上这一层：给模型两个工具，并配一段系统提示词，让它在主要目标明确后把会话名改成 `<type>(<scope>): <主题>` 的约定格式。

## 提供什么

| 名称 | 类型 | 作用 |
|---|---|---|
| `set_session_title(title)` | 工具 | 设置当前会话标题；返回 `previous` / `current`；写入后标题被 **pin**，自动标题停止覆盖 |
| `get_session_title()` | 工具 | 读当前标题与来源（`fallback` / `provider` / `user`），供模型在上下文压缩后自校准 |
| `tool:set_session_title` | 提示词段 | 命名规范：类型枚举、scope、80 字节 / 50 字符上限、set-once、子会话跳过 |

行为要点：

- **只在调用方会话生效**（`exec.agent.session`），不接受 sessionId，无法改别人的会话。
- **子会话拒绝**（`E_CHILD_SESSION`）：subagent 会话不参与命名。
- **超长拒绝而非截断**：按 UTF-8 字节校验（上限读 `sessionTitle.config.maxTitleBytes`，当前 80），错误里回传实际字节数，模型自行缩短重试。
- **幂等**：同标题不追加事件、不重复 pin。
- **pin 语义**：写入 `source: user` 后，fallback / LLM 自动标题都不再覆盖，直到显式 `refresh()`（本插件暂未提供）。

## 安装

需要 Windows + PowerShell（5.1 或 7 均可），默认装到 `%USERPROFILE%\.dsh\profiles\desktop`：

```powershell
# 预览，零写入
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# 安装（备份 patch + staging 替换 + 校验）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 回滚（无安全备份时拒绝并保留一切）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Rollback
```

安装或回滚后需要**重启 DSH Desktop** 生效。

参数：`-ProfilePath <dir>` 指定其它 profile，`-SourcePath <dir>` 指定包源，`-Force` 覆盖已有安装。

## 验证

纯 Node，不需要启动 DSH：

```powershell
node --check src/lib/index.js
node test/smoke.mjs
```

`smoke.mjs` 用 `module.registerHooks` 把 `@deepseek-ai/dsh-tools` 重定向到内存 stub，捕获**原始**工具定义并用内置的 author-schema linter 校验（DSH 的 `defineTool` 在注册时立即编译 schema，写错会直接让插件加载失败），覆盖 30 项：schema 合规、字节校验、幂等、子会话、服务缺失、安装脚本的 YAML 插入 / 编码 / 回滚 / 覆盖安装失败等。

## 已知限制

- **pnpm 清理**：profile 由 pnpm 管理（`nodeLinker: hoisted`）。在 DSH 里增删插件可能触发 `pnpm install`，清掉手装的包目录，导致下次启动找不到插件。改动插件列表后重跑 `install.ps1` 即可；起不来先 `-Rollback`。
- **pin 不可逆**：设过标题后自动标题停止更新，本版本没有 `refresh` 工具（后续可加 `refresh_session_title`）。
- **80 字节上限**：约 25 个汉字；50 字符约束对纯中文场景不生效（字节先到上限）。
- **子会话不支持**：subagent 会话固定跳过。

## 仓库结构

```
src/
  package.json          # @deepseek-ai/dsh-tool-session-title
  lib/index.js          # 插件入口：两个工具 + 一个提示词段
  README.md             # 包级说明
scripts/install.ps1     # 安装 / 回滚（PS 5.1 + 7）
test/smoke.mjs          # 30 项冒烟测试
REQUIREMENTS.md         # 需求基线
design/                 # 设计、schema 规则、修复记录
```

## 设计文档

- [REQUIREMENTS.md](REQUIREMENTS.md) — 需求、验收标准、已验证的 DSH API 事实
- [design/DESIGN.md](design/DESIGN.md) — 架构与 D1–D8 决策
- [design/SCHEMA-RULES.md](design/SCHEMA-RULES.md) — DSH 工具 schema 作者 DSL 的硬规则
- [design/LEAD-NOTES.md](design/LEAD-NOTES.md)、[design/FIX-NOTES.md](design/FIX-NOTES.md) — 评审后的修订与修复清单

## License

未声明。使用前请与作者确认。
