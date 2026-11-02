# 修复清单（Lead 汇总 Codex review + Lead 复核）

结论：**BLOCK**。以下 B1–B4 必须修复；N1–N3 一并处理。修复后必须重跑全部测试，并新增回归用例。

## B1 安装脚本 YAML 插入：改成"锚点插入"，不再找块尾

现状：`Find-InsertBlock` 把"缩进大于 `- insert:` 行"的所有行当作列表内容，遇到同 patch 对象的兄弟键（`  after:`）或无缩进注释就会插错位置，生成非法 YAML。

**新算法（必须照此实现）**：
1. 逐行找第一个匹配 `^(\s*)-\s+insert:\s*(#.*)?$` 的行（记 `insertIndent`、`insertIndex`）。
   - 找不到 → 安全失败（不改任何文件），提示"未找到 `- insert:` 块"。
   - 该行内联 `[]` → 安全失败，提示手工安装。
2. 向后扫描确定子项缩进 `childIndent`：跳过空行与**仅注释**行（`^\s*#`）；遇到的第一个 `^\s*-\s` 且缩进 > `insertIndent` 的行，其缩进即 `childIndent`；若先遇到缩进 ≤ `insertIndent` 的非空非注释行（空列表），则 `childIndent = insertIndent + 4`。
3. 在第一个子项块内确定 `name:` 缩进：从 `childIndent` 行之后找第一个 `^(\s*)name:` 且缩进 > `childIndent` 的行，其缩进即 `nameIndent`；找不到则 `nameIndent = childIndent + 2`。
4. **插入位置 = `insertIndex + 1`**（紧跟 `- insert:` 行，作为列表第一项），插入两行：
   - `(' ' * childIndent) + '- id: tool-session-title'`
   - `(' ' * nameIndent) + 'name: "@deepseek-ai/dsh-tool-session-title"'`
   （也注意：保留 `insertIndex` 行原有的缩进，不要改动原行。）
5. 幂等：全文已存在 `^\s*-\s+id:\s*tool-session-title\s*$` 则跳过插入。
6. 插入后自检（任一失败则不写盘）：行数必须 = 原行数 + 2；`- id: tool-session-title` 恰好出现 1 次；文件不含 `\t`。

这样兄弟键、块前后注释、多条目列表都不会被破坏——因为完全不依赖"块尾"。

## B2 编码：全程显式 UTF-8（无 BOM）

- 读：`[System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false)))`
- 写：先写同目录临时文件（同样 UTF8 无 BOM），再 `Move-Item -LiteralPath $tmp -Destination $path -Force`。
- 禁止 `Get-Content`/`Set-Content`/`Out-File` 参与读写 patch 文件。
- 备份文件同样用 `[System.IO.File]::Copy`。

## B3 回滚：无安全备份时"不删任何东西"

- 找不到 `cordis.patch.yml.bak.*` → 打印错误并 **exit 1**，不删除包目录、不改 patch。
- 最新备份内容若仍匹配 `dsh-tool-session-title` → 打印错误并 **exit 1**，不做任何修改。
- 只有"备份存在且不含本插件引用"时：先恢复备份 → 再删除包目录。
- 恢复后再次校验文件不含本插件引用，否则报错（此时不要删除目录的阶段已经过去，先恢复原 YAML？——按顺序：先只读校验，再恢复，再删除；恢复前完成全部校验）。

## B4 `-Force` 覆盖安装：staging + 回退

顺序必须是：
1. 读 patch、算好新文本（不写）。
2. 备份 patch（若已有注册也备份）。
3. 复制 `src\*` 到 `$TargetParent\.dsh-tool-session-title.staging.<guid>`（同卷）。
4. 校验 staging 内 `lib\index.js` 存在、`package.json` 可 `ConvertFrom-Json`。
5. 若目标已存在：`Move-Item` 到 `$TargetParent\.dsh-tool-session-title.old.<guid>`；失败则清理 staging 并退出。
6. `Move-Item` staging → 目标；失败则把 `.old` 移回并退出。
7. 写 patch（原子替换）；失败则把新目录移走、`.old` 移回、恢复 patch 备份。
8. 成功后删除 `.old`（失败仅警告）。

复制源用 `Get-ChildItem -LiteralPath $SourceDir` 后逐个 `Copy-Item -LiteralPath`，不要用 `Join-Path $SourceDir '*'`（避免路径含 `[` `]` 时被当通配符）。

## N1 幂等检测改为精确匹配
不要全文搜包名；只匹配 `^\s*-\s+id:\s*tool-session-title\s*$`。

## N2 备份保留数量
创建备份后按**当前实际数量**计算超出部分，删除最旧的，使总数 ≤ 5（不要 `+1`）。

## N3 生产代码移除测试 stub
- `src/lib/index.js` 改为**静态** `import { defineTool } from '@deepseek-ai/dsh-tools';`。
- 删除 `loadDshTools`、`export let dshToolsForTests`、`apply` 里的 await（`apply` 改回同步）。
- 删除 `src/lib/.smoke/` 整个目录（不要随包发布）。
- `test/smoke.mjs` 只靠 `registerHooks` 把 `@deepseek-ai/dsh-tools` 指向数据 URL stub（在 `import('../src/lib/index.js')` 之前注册即可，静态 import 同样被解析钩子拦截）；删除对 `.smoke` 模块的引用，`capturedOptions()` 直接返回 `globalThis.__dshStubCalls`。
- 保留"恰好一个 stub 记录"的断言可改为"调用数 > 0 且等于 2 个工具"。

## N4 提示词补全原始约束（保持 ≤400 字符）
必须同时出现：`≤80 字节`、`≤50 字符`、`不以句号结尾`、`pin`、`每个主题只设一次`、`子会话不设标题`、`工具不存在则静默跳过`。
超 400 字符时优先删示例里的第二个例子，不要删上述约束。

## 测试新增（必须）
- T21 兄弟键布局：`- insert:` 下已有条目 + 同级 `after: x`，安装后 YAML 中我们的两行位于列表内且缩进正确（可用文本断言：`after:` 行仍存在且与其前一行缩进一致；我们的 id 行缩进 == 原第一个子项缩进）。
- T22 注释布局：`- insert:` 与首个子项之间、以及子项内部有注释，安装后注释仍在、我们的条目出现在首个子项之前。
- T23 无备份回滚：临时 profile 删除所有 `.bak` 后 `-Rollback` 退出码非 0，且包目录仍存在、patch 未变。
- T24 备份仍引用插件时回滚：构造一个含 `tool-session-title` 的备份，`-Rollback` 退出码非 0 且不删除包。
- T25 `-Force` 复制失败：用只读/不存在的手工 staging 源模拟（或注入：把 src 指向不存在路径），断言旧包目录仍在、patch 未变、退出码非 0。
- T26 UTF-8 保真：patch 内含中文注释与中文路径，安装+回滚后这些字符逐字节不变（用 `[System.IO.File]::ReadAllBytes` 比较安装前备份与回滚后内容）。
- 原有 T1–T20 全部保持通过（T20 改为静态 import 版本）。

## 其他
- README 的"一键回滚"承诺改为准确描述：无备份时拒绝回滚且不删包。
- 清理 `session-title-tool/.scratch/`（设计阶段的临时文件）与测试临时目录。
- 不要安装到真实 profile，不要重启 DSH。
