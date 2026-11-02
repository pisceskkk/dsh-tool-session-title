[English](README.md) | 中文

# dsh-tool-session-title

[![CI](https://github.com/pisceskkk/dsh-tool-session-title/actions/workflows/ci.yml/badge.svg)](https://github.com/pisceskkk/dsh-tool-session-title/actions/workflows/ci.yml)

让 **Agent 自己管理会话标题** 的 DeepSeek Harness（DSH）插件。

## 问题背景

在原生 DeepSeek Harness 中，会话标题仅支持两种变更路径：由 Provider 异步自动生成，或由用户在前端 UI 手动重命名。模型侧既无法读取当前标题，也没有工具更新标题。此外，DSH 的会话标题事件是 `log-only`（仅日志级）记录，**不会进入模型的对话上下文**。这导致 Agent 既无法感知当前会话标题，也无法在主要任务明确后主动对齐标题，在经历多轮会话或上下文压缩后更无法实现自校准。

## 提供什么

| 组件 | 类型 | 说明 |
|---|---|---|
| `set_session_title(title)` | 工具 | 设置当前会话标题；返回 `{ unchanged, previous, current }`。设置后标题被 **pin**（`source: user`），自动标题停止覆盖。 |
| `get_session_title()` | 工具 | 获取当前会话标题与来源（`fallback` / `provider` / `user` / `null`），供模型在上下文压缩后自校准与核对。 |
| `tool:set_session_title` | 系统提示词段 | 注入 `<type>(<scope>): <主题>` 命名规范、字节与字符上限、同主题仅设一次及子会话跳过等规则。顺序为 `2305`，仅在工具可见时注入。 |

## 行为与保证

- **仅对调用方会话生效**：固定绑定调用 Agent 所在的会话（`exec.agent.session`），不接受任意 session ID，无法修改其他会话。
- **子会话拒绝（`E_CHILD_SESSION`）**：子会话（Subagent，即包含 `session.header.parentSession` 的会话）禁止改名，调用直接报错，Subagent 不参与命名。
- **严格字节校验而非截断（`E_TITLE_TOO_LONG`）**：运行时从 `ctx.sessionTitle.config.maxTitleBytes` 读取上限（当前为 80 字节）。若 UTF-8 字节超长，报错并回传实际字节数与上限值，绝不静默截断，由模型自行缩短后重试。
- **错误码设计**：以结构化 `[E_CODE] message` 形式抛出，运行时转换为模型的 `isError` 工具结果：
  - `E_SERVICE_UNAVAILABLE`：`ctx.sessionTitle` 服务缺失。
  - `E_NO_AGENT`：脱离 Agent 会话调用（缺少 `exec.agent.session`）。
  - `E_CHILD_SESSION`：在子会话中调用。
  - `E_EMPTY_TITLE`：`title` 非字符串、为空白字符，或经内部清洗后为空（`SessionTitleInvalidError`）。
  - `E_TITLE_TOO_LONG`：UTF-8 字节数超过 `maxTitleBytes`。
  - `E_SESSION_NOT_LIVE`：会话在底层存储中非活跃（`rename()` 抛错）。
- **同标题幂等**：传入与当前完全一致的标题时，返回 `{ unchanged: true, current: title }`，不触发内部 `rename()`，不追加事件，不重复 pin。
- **Pin 语义保证**：写入标题后来源标记为 `source: user`。在 DSH 语义中，`user` 来源即代表被 pin，Provider 自动标题生成将永久停止覆盖该会话，直到宿主执行 `refresh()`（本插件暂未暴露该方法）。

## 安装

环境要求：Windows 系统，PowerShell 5.1 或 PowerShell 7+。默认 Profile 路径为 `%USERPROFILE%\.dsh\profiles\desktop`。

```powershell
# 1. 预览执行计划（零写入）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# 2. 执行安装（自动备份 patch、Staging 暂存复制、原子写入）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1

# 3. 回滚卸载（恢复最新安全备份并清理包目录）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Rollback
```

> **注意**：安装或回滚完成后，必须**重启 DSH Desktop** 以使插件生效。

### 安装脚本参数

- `-WhatIf`：Dry run 模式。校验前置条件并输出每步操作计划，不修改任何文件。
- `-Rollback`：回滚模式。还原最新的安全备份（`cordis.patch.yml.bak.*`）并删除插件包目录。若无安全备份则拒绝执行并保持原样。
- `-Force`：强制覆盖安装已存在的插件目录。
- `-ProfilePath <path>`：指定目标 Profile 路径（默认为 `%USERPROFILE%\.dsh\profiles\desktop`）。
- `-SourcePath <path>`：指定插件源码目录（默认为仓库的 `src/`）。

## 验证

纯 Node 环境即可运行，无需启动 DSH 进程：

```powershell
# 语法检查
node --check src/lib/index.js
node --check test/smoke.mjs

# 运行 30 项冒烟测试
node test/smoke.mjs
```

`test/smoke.mjs` 通过 Node 的 `module.registerHooks` 将 `@deepseek-ai/dsh-tools` 重定向至内存 Stub，捕获**原始**作者定义，并通过内置的 author-schema linter 校验工具 Schema。30 项测试覆盖：
- 工具定义与参数/输出 Schema 校验。
- 提示词段注册（顺序 `2305`）与按工具可见性动态展示。
- 标题设置、字节限制、空标题报错、同标题幂等与子会话拦截。
- `sessionTitle` 服务或 `agent.session` 缺失异常。
- 标题读取及来源识别（`fallback`、`provider`、`user`、`null`）。
- 安装脚本特性：`-WhatIf` 零写入、幂等重跑、安全回滚、保留兄弟键（`after:`）与原有注释、Staging 替换、无安全备份拒绝回滚，以及 Windows PowerShell 5.1 下无 BOM 的 UTF-8 中文编码保真度。

### 持续集成（CI）

GitHub Actions 工作流（`.github/workflows/ci.yml`）运行于 `windows-latest` + Node 24 环境，执行：
1. `src/lib/index.js` 与 `test/smoke.mjs` 语法检查。
2. 完整运行 30 项冒烟测试（`node test/smoke.mjs`）。
3. 在临时 Profile 目录上执行 `install.ps1 -WhatIf`，校验文件哈希未变且包目录未创建（零写入验证）。

## 已知限制

- **Pin 不可逆**：设置标题后自动标题停止更新，本版本未提供 `refresh` 工具。
- **80 字节上限**：纯中文约为 25 个汉字；命名规范中提到的 50 字符限制在纯中文场景下不会触碰（字节先超限）。
- **pnpm 目录清理风险**：DSH Profile 由 pnpm 统一管理（`nodeLinker: hoisted`）。若在 DSH 前端界面修改插件配置，可能触发 `pnpm install` 将手动复制的包目录清理，导致下次启动失败。如遇该情况，重新运行 `install.ps1` 即可；若 DSH 无法启动，先执行 `install.ps1 -Rollback`。
- **子会话不支持**：Subagent 会话固定跳过，无法设置标题。

## 仓库结构

```
├── .github/workflows/ci.yml  # CI 工作流：语法检查、冒烟测试与 Dry-run 零写入验证
├── design/                   # 设计规范、Schema 规则与评审记录
│   ├── DESIGN.md             # 架构设计与 D1–D8 决策基准
│   ├── FIX-NOTES.md          # 修复与评审修改记录
│   ├── LEAD-NOTES.md         # 架构评审反馈
│   └── SCHEMA-RULES.md       # DSH defineTool author-schema DSL 硬规则
├── scripts/
│   └── install.ps1           # 事务性安装与回滚脚本（兼容 PS 5.1 / 7+）
├── src/
│   ├── lib/
│   │   └── index.js          # 插件入口：工具定义与系统提示词段
│   ├── package.json          # 插件包清单（@deepseek-ai/dsh-tool-session-title）
│   └── README.md             # 包级说明文档
├── test/
│   └── smoke.mjs             # 30 项独立冒烟测试与 Schema 校验器
├── LICENSE                   # MIT 许可证
└── REQUIREMENTS.md           # 需求基线与已验证 DSH 接口事实
```

## 设计文档

- [REQUIREMENTS.md](REQUIREMENTS.md) — 需求基线、验收标准及已验证的 DSH 接口行为。
- [design/DESIGN.md](design/DESIGN.md) — 插件架构、调用流程与 D1–D8 架构决策。
- [design/SCHEMA-RULES.md](design/SCHEMA-RULES.md) — DSH `defineTool` author-schema 编写硬规则。
- [design/LEAD-NOTES.md](design/LEAD-NOTES.md) — 架构评审反馈与修订要点。
- [design/FIX-NOTES.md](design/FIX-NOTES.md) — 针对评审发现的具体问题修复清单。

## License

[MIT](LICENSE) © 2026 Qiu Chunshuo
