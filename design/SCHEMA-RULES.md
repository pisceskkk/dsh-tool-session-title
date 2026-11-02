# DSH 工具 schema 作者 DSL —— 硬性规则（Lead 从 app.asar 源码核实）

来源：`dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`（`runSchemaCompiler` / `compilePropertyMap` / `valueSchemaSpecToJsonSchema` / `parameterSchemaSpecToJsonSchema` / `defineTool`）。

**最重要的事实：`defineTool()` 在注册时会立刻编译 `parameters` 和 `output.schema`，任何不合规都会抛 `JsonSchemaError`。插件在 apply() 阶段抛错 = 插件加载失败 = Desktop 可能起不来。**
因此冒烟测试的 stub 绝不能只做 `defineTool = (x) => x` 就完事，必须同时用本地实现的"规则 linter"检查 schema。

## R1 `parameters` 是属性映射（property map）

```js
parameters: {
  title: { type: 'string', required: true, description: '...' }
}
```
- 每个 value 必须是 schema 对象。
- 属性级 `required` 只能是字面量 `true`；不能是 `false`、不能是数组。
- 编译器自动包成 `{ type:'object', properties:{...}, required:[...] }`。

## R2 value 节点允许的键（按 type）

| type | 允许键（除注解外） |
|---|---|
| `object` | `type`、`properties`、`additionalProperties`（**必须显式 boolean**） |
| `array` | `type`、`items` |
| `string` / `number` / `integer` / `boolean` / `null` | `type`、`enum`、`const` |
| `json` | `type`（仅注解，不受约束） |
| `oneOf` | `oneOf`（**不得同时出现 `type`**，分支 ≥ 2） |

注解键：`description`、`title`、`default`、`examples`。

## R3 对象级 `required: [...]` 数组是被拒绝的

对象节点不允许 `required` 数组（`assertAuthorKeys` 会报 `schema.required is not supported by the value schema DSL`）。
必填只能通过**属性节点上的 `required: true`** 表达，编译器负责汇总到父级 `required` 数组。

## R4 每个 object 节点必须显式写 `additionalProperties`

```js
{ type: 'object', additionalProperties: false, properties: { ... } }
```
漏写 → `schema.additionalProperties must be explicitly true or false`。

## R5 `oneOf` 分支是 value 节点

```js
previous: { oneOf: [{ type: 'string' }, { type: 'null' }] }
```
- 分支里同样遵守 R2/R4（分支是 object 时也要 `additionalProperties`）。
- 分支里可带 `enum`、`const`。

## R6 正确的输出 schema 形状（照抄）

`set_session_title`：

```js
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      unchanged: { type: 'boolean', required: true },
      previous: { oneOf: [{ type: 'string' }, { type: 'null' }] },   // 可选字段：不要写 required
      current: { type: 'string', required: true }
    }
  },
  render: (_args, value) => [{ type: 'text', text: '...' }]
}
```

`get_session_title`：

```js
output: {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      source: {
        oneOf: [
          { type: 'string', enum: ['fallback', 'provider', 'user'] },
          { type: 'null' }
        ],
        required: true
      }
    }
  },
  render: (_args, value) => [{ type: 'text', text: '...' }]
}
```

## R7 冒烟测试必须自带 linter

在 `test/smoke.mjs` 里实现 `lintAuthorSchema(spec, path)`，至少校验：

1. 节点必须是普通对象；
2. 键在白名单内（R2 + `required` 仅在属性位置且必须为 `true`）；
3. `type` 与 `oneOf` 互斥；`oneOf.length >= 2`；
4. `type === 'object'` 时必须存在 boolean 的 `additionalProperties`，且**不得**有 `required` 数组；
5. 递归检查 `properties` / `items` / `oneOf` 分支。

然后对**两个工具**的 `parameters` 与 `output.schema` 都跑 linter，从 stub 捕获的原始 options 上取（不是编译后的 JSON Schema）。

## R8 `defineTool` stub 必须记录原始 options

```js
export function defineTool(options) { registered.push(options); return options; }
```
这样 linter 才能看到作者写法；只返回 `options` 不记录会导致测试假绿。

## R9 运行时错误与返回值

- `execute` 抛 `Error` → 运行时转成 `isError` 结果，message 进模型上下文（review 阶段确认）。
- `output.render` 返回 `[{ type: 'text', text }]`；`text` 为空字符串也合法，但不要返回 undefined。

## R10 提示词段

```js
ctx.systemPrompt.section({
  name: 'tool:set_session_title',
  order: 2305,                       // 2300 已被 TOOL_SESSION_QUERY 占用
  text: ({ scope }) => ctx.tools.get('set_session_title', scope) === undefined ? '' : PROMPT_TEXT
});
```
