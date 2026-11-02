# Lead 审阅意见（对 DESIGN.md 的修订指令）

设计整体可用。实现前必须按以下 9 条修订，**与 DESIGN.md 冲突时以本文件为准**。

## C1 提示词段 order 不能用 2300
`SECTION_ORDERS` 里 `TOOL_SESSION_QUERY` 已经是 **2300**（已在 app.asar 中核实）。同值会按 name 的 code-unit 排序，顺序不可控。
→ 改用 **2305**，并在注释里写明"2300 已被 TOOL_SESSION_QUERY 占用"。

## C2 section 的 text 回调签名
已核实类型：`text: string | ((context: AssembleContext) => string)`，仓库内既有写法是：
```js
text: ({ scope }) => ctx.tools.get('set_session_title', scope) === undefined ? '' : PROMPT_TEXT
```
→ 用 `({ scope })` 解构，不要写 `(context) => context.scope`。

## C3 maxTitleBytes 不要硬编码死
工具描述与校验都用同一个上限值；优先运行时读取：
```js
const maxBytes = ctx.sessionTitle?.config?.maxTitleBytes ?? 80;
```
若 `config` 不可读（undefined），回退 80，并在 README 里注明"上限变更后需同步"。工具 description 里不要写死 "80"，写 "the session title byte limit"。

## C4 补一个错误码
`exec.agent === undefined`（非 agent 调用）→ `E_NO_AGENT`，文案 `This tool requires an owning agent session.`。

## C5 pnpm 可能清理手装目录（必须写进 README 与脚本提示）
profile 由 pnpm 管理（`nodeLinker: hoisted`）。在 GUI 里增删插件可能触发 `pnpm install`，把不在 `package.json` 里的手工目录清掉，届时 host 启动会报插件缺失。
→ `install.ps1` 安装完成后打印醒目提示：**"安装后不要在 DSH 里变更插件列表；若变更过，重新运行本脚本恢复。"** 并在 README「已知限制」中记录。安装脚本必须可重复执行（幂等）。

## C6 错误抛出格式
统一 `throw new Error('[E_XXX] <english message>')`。DSH 会把 execute 抛出的错误转成 `isError` 结果给模型；review 阶段要确认这一点，若实际被包装成别的形状，以实际为准调整。

## C7 幂等比较
用 `ctx.sessionTitle.get(session)?.title === title` 精确比较（不做 trim 归一化）。注意 `title` 先用 `String(args.title)` 取值并 `trim()` 后再比。

## C8 安装脚本的 YAML 追加必须保守
`cordis.patch.yml` 末尾已有：
```yaml
- insert:
    - id: magpie-mcp-magpie
      name: "@deepseek-ai/dsh-mcp-client"
      config: ...
```
→ 只在**已存在**的 `- insert:` 块下、以 4 空格缩进追加两条（`- id:` / `    name:`），不要新建第二个 `- insert:`（重复 key 语义不清）。追加前先检测 `tool-session-title` 是否已存在。写入用原子替换（临时文件 + Move-Item）。

## C9 测试必须覆盖内容
除 DESIGN.md 的 T1–T12 外，新增：
- T13 `exec.agent === undefined` → `E_NO_AGENT`
- T14 `maxTitleBytes` 从 `ctx.sessionTitle.config` 读取生效（配置成 20 时 21 字节被拒）
- T15 section text 在工具不可见时返回 `''`、可见时返回非空且包含 `set_session_title`
- T16 `install.ps1 -WhatIf` 不改动任何文件（用临时 profile 目录测，或在脚本层用 dry-run 断言）

## 交付时必须自检
1. `node --check` 所有 `.js` / `.mjs`
2. `node test/smoke.mjs` 全绿
3. 不修改 `session-title-tool/` 之外的任何文件；**不要**安装到 `~/.dsh`，**不要**重启 DSH
