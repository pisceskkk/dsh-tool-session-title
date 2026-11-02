# 会话标题工具插件设计文档

> 状态：设计基线 v1.0  
> 作者：方案设计 agent (Opus)  
> 日期：2026-10-31  
> 需求基线：[REQUIREMENTS.md](../REQUIREMENTS.md)

---

## 目录

1. [目标与非目标](#1-目标与非目标)
2. [架构与运行路径](#2-架构与运行路径)
3. [决策记录 D1–D8](#3-决策记录-d1d8)
4. [精确接口定义](#4-精确接口定义)
5. [提示词段](#5-提示词段)
6. [文件清单](#6-文件清单)
7. [测试计划](#7-测试计划)
8. [安装与回滚](#8-安装与回滚)
9. [风险表与缓解](#9-风险表与缓解)
10. [范围外事项](#10-范围外事项)
11. [验收清单](#11-验收清单)

---

## 1. 目标与非目标

### 目标

| 编号 | 目标 |
|------|------|
| G1 | Agent 通过 `set_session_title` 工具主动设置当前会话标题为约定格式 |
| G2 | 提示词段（system prompt section）随插件自动注册，仅当工具存在时生效 |
| G3 | 插件可安全安装到 `~/.dsh/profiles/desktop`，失败可一键回滚 |
| G4 | 不改变自动标题行为；agent 设置后标题 pin 住（`source.kind === 'user'`），自动标题不再覆盖 |
| G5 | 提供 `get_session_title` 只读工具，帮助模型在上下文压缩后自校准，避免重复或盲目设置 |

### 非目标

- 不提供 `refresh()` / 解除 pin 的工具
- 不修改 DSH 本体（app.asar）
- 不处理 Web UI 按钮/快捷键
- 不修改 `maxTitleBytes`
- 不对非 live 会话（归档/历史）做任何操作

---

## 2. 架构与运行路径

### 2.1 插件加载

```
DSH Desktop 启动
 → Host 读取 cordis.patch.yml
 → 发现 insert 条目 { id: 'tool-session-title', name: '@deepseek-ai/dsh-tool-session-title' }
 → 从 node_modules/@deepseek-ai/dsh-tool-session-title/lib/index.js 加载 ESM 模块
 → 校验 inject 声明的服务依赖 ['tools', 'systemPrompt', 'sessionTitle']
 → 调用 apply(ctx, config)
   → ctx.tools.register(setSessionTitleTool)
   → ctx.tools.register(getSessionTitleTool)
   → ctx.systemPrompt.section({ name, order, text })
```

### 2.2 工具调用路径（set_session_title）

```
模型输出 tool_call: set_session_title({ title: "feat(auth): 支持 SSO" })
 → DSH 运行时解析参数、匹配到注册的工具定义
 → execute(args, exec) 被调用
   ├─ 1. 取 session: exec.agent.session
   ├─ 2. 检查子会话: session.header.parentSession !== undefined → 报错 E_CHILD_SESSION
   ├─ 3. 空标题校验: args.title.trim() === '' → 报错 E_EMPTY_TITLE
   ├─ 4. UTF-8 字节校验: Buffer.byteLength(args.title, 'utf8') > 80 → 报错 E_TITLE_TOO_LONG
   ├─ 5. 幂等检查: ctx.sessionTitle.get(session)?.title === args.title → 返回 { unchanged: true, current: title }
   ├─ 6. 调用 ctx.sessionTitle.rename(session, args.title)
   │     → 写入 source.kind === 'user'，pin 住标题
   └─ 7. 返回 { unchanged: false, previous: oldTitle ?? null, current: args.title }
```

### 2.3 工具调用路径（get_session_title）

```
模型输出 tool_call: get_session_title({})
 → execute(args, exec) 被调用
   ├─ 1. 取 session: exec.agent.session
   ├─ 2. 调用 ctx.sessionTitle.get(session)
   └─ 3. 返回 { title: string | null, source: 'fallback' | 'provider' | 'user' | null }
```

### 2.4 提示词段注入路径

```
每次构建模型请求时:
 → systemPrompt 服务按 order 排序所有 section
 → text 回调被调用
 → 检查 tools 注册表中是否有 'set_session_title' 工具
   → 有: 返回提示词段全文
   → 无: 返回空字符串（不占 token）
```

---

## 3. 决策记录 D1–D8

### D1 工具名：`set_session_title`

**结论**：采用 `set_session_title`

**理由**：
1. DSH 的核心术语是 **session**，不是 thread。代码库中 `sessionTitle`、`session.header`、`SessionId` 全部使用 session；用 thread 会造成术语不一致。
2. 用户原规则中写 `set_thread_title` 是因为用户的 prompt 模板面向通用场景（一些平台用 thread）。在 DSH 内部语境下应以平台术语为准。
3. `rename_session` 语义不够具体（rename 什么？），且不如 `set_session_title` 清晰地表达"设置标题"。
4. 提示词段中将同步使用 `set_session_title` 以保持自洽。

**被否方案**：
- `set_thread_title`：与 DSH 术语体系冲突；模型在 DSH 环境中不应看到 thread 概念
- `rename_session`：动词 rename 暗示"已有名→改名"，而新会话是"首次命名"，语义不精确

---

### D2 是否提供 `get_session_title`：**提供**

**结论**：提供 `get_session_title` 只读工具

**理由**：
1. **上下文压缩问题**：DSH 会对长对话做上下文压缩/截断，模型可能丢失"自己是否已设置过标题"的记忆。没有 get 工具时，模型只能通过猜测来决定是否调用 set，会导致重复设置或犹豫不设。
2. **自校准**：模型可先 get 查看当前标题及来源（`source: 'user'` 表示已 pin），再决定是否需要 set。这比幂等检查更经济（不需要构造一个完整标题来"试"）。
3. **token 开销极低**：工具定义仅多约 50 token，无参数、输出简单。
4. **与幂等互补**：get 在决策前检查，幂等在执行时兜底。二者不冲突。

**被否方案**：
- 不提供 get，仅靠幂等 + `previous` 返回值：模型在压缩后无法知道自己已经设置过，会盲目重试

---

### D3 子会话策略：**默认跳过（报错）**

**结论**：当 `session.header.parentSession !== undefined` 时返回结构化错误 `E_CHILD_SESSION`，不修改标题

**理由**：
1. 子会话是 subagent 等机制创建的，有独立生命周期但通常不在 UI 主会话列表中显眼展示。给子会话设标题没有用户可见价值。
2. 如果允许，子 agent 可能按自己的任务重命名子会话，这与"set once per main theme"的设计意图冲突。
3. 报错而非静默跳过，是为了让模型明确知道为什么失败，避免重试循环。

**被否方案**：
- 允许但不鼓励：增加复杂度，无明确用户价值
- 可配置：过早引入配置项，违反 YAGNI；后续如有需求可在 config 中添加 `allowChildSession: true`

---

### D4 超长标题处理：**报错（不截断）**

**结论**：UTF-8 字节超过 `maxTitleBytes`（80）时拒绝并报错，返回实际字节数，让模型自行修正

**理由**：
1. DSH `rename()` 本身会做静默截断（已验证事实 #6），但截断会破坏结构化标题格式（如截在汉字中间、截掉类型前缀），结果不可预测。
2. 报错并给出实际字节数（如 `"actual_bytes": 96`）和上限（`"max_bytes": 80`），模型有足够信息自己缩短。
3. 错误文案设计为模型可读的自助修正指引："Title is 96 UTF-8 bytes; max is 80. Shorten and retry."

**错误文案**（模型可见）：
```
Title exceeds the byte limit: {actual} UTF-8 bytes given, max {max}. Shorten the title and retry.
```

**被否方案**：
- 静默截断：破坏结构化格式，模型不知道标题被改了什么
- 截断 + 告知：增加复杂度，且截断后的格式可能无效，不如让模型重试

---

### D5 幂等语义：**同标题 no-op，返回 `unchanged: true`**

**结论**：当请求标题与当前标题完全相同时，不追加任何事件，返回 `{ unchanged: true, current: title }`

**理由**：
1. 避免无意义的 `session/title` 事件堆积。
2. `unchanged: true` 让模型明确知道标题已是目标值、无需进一步操作。
3. 不触发 `rename()`，因此不改变 `source`、不重复 pin。

**返回值语义差异**：

| 场景 | `unchanged` | `previous` | `current` |
|------|-------------|------------|-----------|
| 首次设置 | `false` | `null` 或自动标题 | 新标题 |
| 修改 | `false` | 旧标题 | 新标题 |
| 同值重复 | `true` | *(不返回)* | 当前标题 |

---

### D6 提示词段文本与 `order` 取值

**结论**：`order: 2300`

**理由**：
1. `getSectionOrder()` 只接受内建枚举名（如 `TOOL_SUBAGENT`）；外部插件贡献的 section 必须使用数字。
2. 已知 `TOOL_SUBAGENT` 的 order 在工具相关区间。标题规则是一种行为指导，应在工具描述之后（让模型先知道工具存在，再看使用规则）。
3. 2300 处于合理的中间位置，不与已知内建 section 冲突。

**待实现验证**：确认 2300 不与现有内建 section order 冲突。验证方法：在 DSH 运行时通过 `ctx.systemPrompt.getSectionOrder` 枚举已知名称的返回值，或观察 devtools 中 system prompt 的 section 顺序。

**提示词段全文**：见 [第 5 节](#5-提示词段)

---

### D7 安装形态：**install.ps1 脚本，用户手动执行**

**结论**：提供 `scripts/install.ps1`，具备备份、幂等、dry-run（`-WhatIf`）、回滚（`-Rollback`），由用户在 PowerShell 中手动执行

**理由**：
1. **安全性**：直接改 live profile 有崩溃风险（已验证事实 #9：加载失败导致 host 启动失败）。脚本提供回滚能力。
2. **可见性**：用户在 `-WhatIf` 下可预览所有操作，包括将写入的文件路径和 cordis.patch.yml 变更。
3. **幂等性**：多次执行不产生重复条目或多余备份。
4. **备份策略**：执行前复制 `cordis.patch.yml` → `cordis.patch.yml.bak.{timestamp}`，最多保留 5 个备份。

**安装步骤**：
1. 复制 `src/` → `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/dsh-tool-session-title/`
2. 在 `cordis.patch.yml` 的 `- insert:` 数组中追加条目
3. 提示用户重启 DSH Desktop

**被否方案**：
- 全自动安装（无交互）：风险不可控，用户无法预览
- 手动指南（无脚本）：操作繁琐易出错

---

### D8 与自动标题的关系：**在提示词段中说明**

**结论**：提示词段中明确告知模型："设置后自动标题将停止更新（pin），请一次设好"

**理由**：
1. `rename()` 写入 `source.kind === 'user'` 后，all-prompts 自动标题 provider 不再覆盖。这是一个不可逆副作用（除非调 `refresh()`，本次不提供）。
2. 模型需要知道这个语义，才能遵守"set once"原则，不随意多次设置。
3. 不在工具 description 中重复这个信息（过冗长），而是放在提示词段中详细说明。

**被否方案**：
- 不说明：模型可能频繁改标题，造成用户困惑
- 在工具 description 中说明：工具 description 应聚焦参数/功能，策略性指导属于 prompt section

---

## 4. 精确接口定义

### 4.1 工具：`set_session_title`

```js
defineTool({
  name: 'set_session_title',

  description:
    'Set the title of the current session. The title is pinned after setting ' +
    '(automatic title updates stop). Returns the previous and current title. ' +
    'Rejects child sessions, empty titles, and titles exceeding 80 UTF-8 bytes.',

  parameters: {
    title: {
      type: 'string',
      required: true,
      description:
        'New session title. Must be non-empty and ≤ 80 UTF-8 bytes. ' +
        'Format: <type>(<scope>): <subject>. ' +
        'Example: "feat(auth): 支持 SSO"'
    }
  },

  output: {
    schema: {
      type: 'object',
      properties: {
        unchanged: { type: 'boolean' },
        previous: {
          oneOf: [
            { type: 'string' },
            { type: 'null' }
          ]
        },
        current: { type: 'string' }
      },
      required: ['current'],
      additionalProperties: false
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.unchanged
        ? `Title unchanged: ${value.current}`
        : `Title set: ${value.previous ?? '(none)'} → ${value.current}`
    }]
  },

  execute(args, exec) { /* 见第 2 节运行路径 */ }
})
```

### 4.2 工具：`get_session_title`

```js
defineTool({
  name: 'get_session_title',

  description:
    'Get the current title and source of this session. ' +
    'Source is "fallback", "provider" (auto-generated), or "user" (manually set/pinned).',

  parameters: {},

  output: {
    schema: {
      type: 'object',
      properties: {
        title: {
          oneOf: [
            { type: 'string' },
            { type: 'null' }
          ]
        },
        source: {
          oneOf: [
            { type: 'string', enum: ['fallback', 'provider', 'user'] },
            { type: 'null' }
          ]
        }
      },
      required: ['title', 'source'],
      additionalProperties: false
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.title !== null
        ? `Current title (${value.source}): ${value.title}`
        : 'No title set.'
    }]
  },

  execute(args, exec) { /* 见第 2 节运行路径 */ }
})
```

### 4.3 错误码与错误文案

| 错误码 | 条件 | 模型可见文案（英文） | 人类可读说明（中文） |
|--------|------|---------------------|---------------------|
| `E_CHILD_SESSION` | `session.header.parentSession !== undefined` | `Cannot set title on a child session. Only the root session title can be changed.` | 子会话不支持设置标题，仅根会话可操作 |
| `E_EMPTY_TITLE` | `args.title.trim() === ''` | `Title must not be empty.` | 标题不能为空 |
| `E_TITLE_TOO_LONG` | `Buffer.byteLength(title, 'utf8') > maxTitleBytes` | `Title exceeds the byte limit: {actual} UTF-8 bytes given, max {max}. Shorten the title and retry.` | 标题超长：实际 {actual} 字节，上限 {max} 字节。请缩短后重试 |
| `E_SERVICE_UNAVAILABLE` | `ctx.sessionTitle` 服务缺失 | `Session title service is unavailable. The tool cannot function without it.` | 标题服务不可用，工具无法运行 |
| `E_SESSION_NOT_LIVE` | `rename()` 抛出 Error（会话不在 store） | `Session is not live; title cannot be changed.` | 会话非 live 状态，无法修改标题 |

**错误返回结构**（所有错误统一格式，抛 Error 由 execute 内部捕获后 throw）：

```js
// execute 内部抛出的 Error 会被 DSH 运行时捕获并返回给模型
throw new Error(`[${errorCode}] ${englishMessage}`);
```

> **待实现验证**：确认 DSH 运行时对 `execute` 抛出的 Error 的处理方式——是透传 message 给模型，还是包装为特定格式。验证方法：查看现有工具（如 subagent）的错误抛出与模型接收的对应关系。

---

## 5. 提示词段

### 5.1 全文（中文落地版，398 字）

```
如果 set_session_title 工具可用，请在主要目标明确后尽早设置会话标题。

格式：<type>(<scope>[, <scope>]): <简短中文主题>
- type 取值：feat | bugfix | docs | style | refactor | perf | test | chore | review | spike | misc
- scope：1–2 个简洁的模块/功能关键词
- 主题：用中文概括，技术术语和缩写保持英文（如 SSO、PCP）
- 示例：feat(auth): 支持 SSO、perf(DSv4, PCP): 优化多流重叠

约束：
- 标题不超过 80 字节（约 25 个汉字），不以句号结尾
- 设置后自动标题将停止更新（pin），请一次设好
- 每个主题只设一次；仅在用户明确要求或主要目标发生实质转变时更新；忽略次要话题偏移
- 子会话（subagent 创建）不设标题
- 如不确定当前标题状态，可先调用 get_session_title 查看
- 如标题超长被拒，根据返回的字节数缩短后重试
- 若工具不存在则静默跳过，不要提及标题设置
```

### 5.2 `order` 取值

```js
ctx.systemPrompt.section({
  name: 'tool:set_session_title',
  order: 2300,
  text: (context) => {
    // 仅当 set_session_title 工具对当前 scope 可见时返回文本
    if (ctx.tools.get('set_session_title', context.scope) === undefined) return '';
    return PROMPT_TEXT; // 上述全文
  }
});
```

**理由**：
- `getSectionOrder` 只接受内建枚举名，外部插件用数字
- 2300 位于工具指导区间（`TOOL_SUBAGENT` 附近），确保模型先看到工具定义再看使用规则
- section name 为 `'tool:set_session_title'`，遵循现有 `'tool:subagent'` 的命名惯例

---

## 6. 文件清单

```
session-title-tool/
├─ REQUIREMENTS.md                           # 需求基线（已有，不修改）
├─ design/
│  └─ DESIGN.md                              # 本设计文档
├─ src/
│  ├─ package.json                           # 包元数据
│  │   - name: "@deepseek-ai/dsh-tool-session-title"
│  │   - type: "module"
│  │   - main: "lib/index.js"
│  │   - peerDependencies: { "@deepseek-ai/dsh-tools": "*" }
│  ├─ lib/
│  │  └─ index.js                            # 插件入口
│  │      - export const name: string
│  │      - export const inject: string[]
│  │      - export function apply(ctx, config): void
│  └─ README.md                              # 安装/卸载/验证/已知限制
├─ test/
│  └─ smoke.mjs                              # 纯 Node 冒烟测试
│      - 使用 module.registerHooks 做 @deepseek-ai/dsh-tools stub
│      - 测试用例详见第 7 节
├─ scripts/
│  └─ install.ps1                            # 安装到 profile 的 PowerShell 脚本
│      - 参数：-WhatIf / -Rollback / -Force
│      - 详见第 8 节
└─ review/
   └─ REVIEW.md                              # Codex 代码检视产出（后续阶段填写）
```

### 6.1 `src/lib/index.js` 关键导出签名

```js
// 插件名，Cordis 用于标识
export const name = 'tool-session-title';

// 声明依赖的 ctx 服务
export const inject = ['tools', 'systemPrompt', 'sessionTitle'];

/**
 * 插件入口：注册工具和提示词段
 * @param {import('@deepseek-ai/dsh-tools').Context} ctx - Cordis 上下文
 * @param {undefined} config - 本插件无配置
 */
export function apply(ctx, config) {
  // 1. 注册 set_session_title 工具
  // 2. 注册 get_session_title 工具
  // 3. 注册系统提示词段
}
```

### 6.2 `src/package.json` 结构

```json
{
  "name": "@deepseek-ai/dsh-tool-session-title",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": "*"
  }
}
```

---

## 7. 测试计划

### 7.1 测试环境

- **运行环境**：纯 Node.js（≥ 20），不启动 DSH 进程
- **依赖隔离**：使用 `module.registerHooks` 将 `@deepseek-ai/dsh-tools` 映射到本地 stub，stub 提供 `defineTool` 的最小实现
- **执行命令**：`node test/smoke.mjs`

### 7.2 Stub 设计

```js
// test/stubs/dsh-tools-stub.js
export function defineTool(definition) {
  // 返回 definition 自身，仅做 schema 合规性记录
  return definition;
}
```

模拟对象：
- `ctx.tools.register(def)` → 收集注册的工具定义
- `ctx.tools.get(name, scope)` → 按 name 查找已注册的定义
- `ctx.systemPrompt.section(spec)` → 收集提示词段注册
- `ctx.sessionTitle.get(session)` → 返回可配置的 mock 数据
- `ctx.sessionTitle.rename(session, title)` → 记录调用、返回 mock 结果
- `exec.agent.session` → mock session 对象（可配置 `header.parentSession`）

### 7.3 测试用例

| 编号 | 用例名 | 断言 |
|------|--------|------|
| T1 | 导出形状 | 模块导出 `name`（string）、`inject`（包含 'tools', 'systemPrompt', 'sessionTitle'）、`apply`（function） |
| T2 | 工具 schema | `set_session_title` 的 parameters 包含 `title: { type: 'string', required: true }`；`get_session_title` 的 parameters 为空对象 |
| T3 | 提示词段注册 | section 的 `name` 为 `'tool:set_session_title'`、`order` 为 `2300`、`text` 为函数且返回非空字符串（当工具可见时） |
| T4 | 提示词段条件隐藏 | 当 `ctx.tools.get('set_session_title', scope)` 返回 `undefined` 时，`text` 回调返回空字符串 |
| T5 | 正常设置 | 调用 `execute({ title: 'feat(auth): 支持 SSO' }, exec)` 成功；返回包含 `unchanged: false`、`current` 匹配、`previous` 为旧值或 null |
| T6 | 幂等 | 当前标题与请求标题相同时返回 `{ unchanged: true, current: ... }`；`rename()` 未被调用 |
| T7 | 超长拒绝 | 标题 > 80 字节 → 抛错且 message 包含 `E_TITLE_TOO_LONG` 和实际字节数 |
| T8 | 空标题拒绝 | `title: ''` 和 `title: '   '` → 抛错且 message 包含 `E_EMPTY_TITLE` |
| T9 | 子会话拒绝 | `session.header.parentSession` 非空 → 抛错且 message 包含 `E_CHILD_SESSION` |
| T10 | 服务缺失 | `ctx.sessionTitle` 为 undefined → 抛错且 message 包含 `E_SERVICE_UNAVAILABLE` |
| T11 | get 正常 | `get_session_title` 的 `execute` 返回 `{ title, source }` 结构 |
| T12 | get 无标题 | `ctx.sessionTitle.get()` 返回 `undefined` → 返回 `{ title: null, source: null }` |

### 7.4 测试结果判定

- 所有用例通过：输出 `✓ {N} tests passed`，退出码 0
- 任何用例失败：输出失败详情，退出码 1

---

## 8. 安装与回滚

### 8.1 `scripts/install.ps1`

**参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `-WhatIf` | switch | Dry-run 模式，仅打印将执行的操作，不做实际变更 |
| `-Rollback` | switch | 回滚模式：恢复最近的 cordis.patch.yml 备份 + 删除包目录 |
| `-Force` | switch | 覆盖已存在的包目录（默认若已存在则跳过并提示） |
| `-ProfilePath` | string | 可选，覆盖默认的 `$env:USERPROFILE\.dsh\profiles\desktop` |

**安装流程**（正常模式）：

1. **路径推导**：`$ProfilePath` 默认 `$env:USERPROFILE\.dsh\profiles\desktop`
2. **前置检查**：
   - 确认 `$ProfilePath\cordis.patch.yml` 存在
   - 确认 `$ProfilePath\node_modules\@deepseek-ai\` 目录存在
3. **备份**：复制 `cordis.patch.yml` → `cordis.patch.yml.bak.{yyyyMMddHHmmss}`
4. **复制包**：将 `src/` 内容复制到 `$ProfilePath\node_modules\@deepseek-ai\dsh-tool-session-title\`
   - 如目录已存在且未指定 `-Force`，打印警告并跳过（幂等）
   - 如指定 `-Force`，先删除旧目录再复制
5. **修改 cordis.patch.yml**：
   - 读取 YAML
   - 查找 `- insert:` 条目
   - 如其中已有 `id: tool-session-title` 则跳过（幂等）
   - 否则在 insert 数组末尾追加：
     ```yaml
     - id: tool-session-title
       name: "@deepseek-ai/dsh-tool-session-title"
     ```
6. **提示**：`Installation complete. Restart DSH Desktop to activate.`

**回滚流程**（`-Rollback`）：

1. 查找最近的 `cordis.patch.yml.bak.*` 文件
2. 用备份覆盖 `cordis.patch.yml`
3. 删除 `$ProfilePath\node_modules\@deepseek-ai\dsh-tool-session-title\` 目录
4. 提示：`Rollback complete. Restart DSH Desktop to apply.`

### 8.2 幂等性保证

- 多次执行安装：包目录已存在则跳过（或 `-Force` 覆盖），cordis.patch.yml 已有条目则跳过
- 多次执行回滚：无备份文件时报告 "No backup found" 并退出

### 8.3 何时生效

安装或回滚后，必须**重启 DSH Desktop**（或触发 profile 重载）才生效。脚本在最后打印此提示。

---

## 9. 风险表与缓解

| # | 风险 | 影响 | 概率 | 缓解措施 |
|---|------|------|------|----------|
| R1 | **插件语法/依赖错误导致 Desktop 启动失败** | 严重 | 中 | 冒烟测试（`node --check` + smoke.mjs）+ 安装前备份 + `-Rollback` 一键恢复 |
| R2 | `rename()` pin 住自动标题，用户以为自动标题功能坏了 | 中等 | 中 | 提示词段明确说明 pin 语义 + README 说明 + 后续保留 `refresh` 扩展位 |
| R3 | 80 字节上限与 50 字符规则冲突（3 字节汉字最多约 25 个） | 低 | 低 | 工具按字节拒绝并回报实际字节数；提示词段写"≤ 80 字节（约 25 个汉字）" |
| R4 | 模型在上下文压缩后忘记已设标题，反复调用 | 低 | 中 | 提供 `get_session_title` + 幂等返回 `unchanged: true` |
| R5 | `order: 2300` 与 DSH 未来内建 section 冲突 | 低 | 低 | 文档标注为"待实现验证"；未来 DSH 升级时需检查 |
| R6 | cordis.patch.yml 格式变化导致安装脚本解析失败 | 中等 | 低 | 脚本使用简单的文本追加（不做完整 YAML 解析），仅追加到 insert 数组末尾 |
| R7 | `ctx.sessionTitle` 服务在某些 profile 配置下未注入 | 低 | 低 | `inject` 声明硬依赖；启动时若服务缺失 Cordis 会报错，不会悄悄注册残缺工具 |

---

## 10. 范围外事项

以下事项明确不在本次设计和实现范围内：

1. **`refresh()` / 解除 pin 工具**：不提供取消 pin 的能力；作为后续扩展预留
2. **修改 DSH 本体**（app.asar）：所有改动限于 profile 目录
3. **Web UI 标题编辑交互**：DSH 已有 rename UI，本插件不涉及
4. **修改 `maxTitleBytes`**：如需支持更长标题（50 个汉字 = 150 字节），需另行提案
5. **多语言提示词段**：本次只提供中文落地版；如需英文版后续扩展
6. **标题格式校验**：工具不校验 `type(scope): subject` 格式的合规性（模型自律），仅校验空/超长
7. **会话归档/历史会话标题修改**：仅支持 live 会话
8. **自动触发**：不在会话创建时自动调工具；由模型根据 prompt 自行决定

---

## 11. 验收清单

- [ ] A1 `node --check src/lib/index.js` 通过
- [ ] A2 `node test/smoke.mjs` 全绿（覆盖 T1–T12 所有用例）
- [ ] A3 `install.ps1 -WhatIf` 打印将执行的操作，不做实际变更
- [ ] A4 `install.ps1` 真实执行前备份 `cordis.patch.yml`
- [ ] A5 `install.ps1 -Rollback` 恢复备份 + 删除包目录
- [ ] A6 产物不含硬编码用户路径（脚本用 `$env:USERPROFILE` 推导）
- [ ] A7 提示词段 ≤ 400 字
- [ ] A8 提示词段中工具名与注册的工具名一致（`set_session_title`）
- [ ] A9 `get_session_title` 返回结构包含 `title` 和 `source`
- [ ] A10 错误码稳定（`E_CHILD_SESSION` / `E_EMPTY_TITLE` / `E_TITLE_TOO_LONG` / `E_SERVICE_UNAVAILABLE` / `E_SESSION_NOT_LIVE`）
- [ ] A11 代码 review（Codex）无 blocking 问题
- [ ] A12 README.md 包含安装、卸载、验证、已知限制四个章节

---

## 附录 A：待实现验证清单

| 编号 | 问题 | 验证方法 |
|------|------|----------|
| V1 | `order: 2300` 是否与内建 section 冲突 | 在 DSH devtools 中观察 system prompt 的 section 排序 |
| V2 | `execute` 抛出的 Error message 是否完整透传给模型 | 查看现有工具的错误处理代码，或在测试环境中实际触发 |
| V3 | `inject` 中声明 `'sessionTitle'` 但服务缺失时，Cordis 的行为（是启动报错还是延迟注入） | 查看 Cordis 源码中 inject 的处理逻辑 |
| V4 | `cordis.patch.yml` 的 `- insert:` 是否总是存在 | 检查无插件安装的默认 profile 的 cordis.patch.yml |
