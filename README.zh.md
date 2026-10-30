# 临时会话（Temporary Sessions）× DeepSeek Harness

[English](README.md)

一个无依赖的 DSH 插件，提供两种**临时会话**：

- 工作区里的**临时聊天**：从正常的「新会话」流程创建，正常使用，退出应用时删除；
- 选中文字后从右侧栏打开的**临时侧聊**：fork 当前会话，继承上下文，选中文字预填到输入框；可一键提升为长期会话，否则退出时删除。

插件是标准 DSH 组合包（Host 插件 + Web Client 模块），纯 JavaScript、无构建步骤，可以直接从 GitHub 安装。

![工作区「+」菜单：新会话 / 临时会话](docs/screenshot.png)

## 功能

- **工作区「+」菜单**：点工作区行的「+」会弹出「新会话 / 临时会话」二选一；临时会话直接建在该工作区，不会再让你选工作区。「新会话」行里的「临时」选项仍可把刚创建的空白会话标记为临时。
- **选中文字开侧聊**：在会话里选中文字，点浮出的「临时会话」，右侧栏打开一个 fork 会话，选中文字以引用形式预填到输入框。
- **提升为长期会话**：侧聊顶部一键「提升为长期会话」；Host 删除临时记录、行重新出现在侧栏，退出时不再删除。
- **完整原生会话**：使用真实的 Agent、工具、模型、权限、流式输出与继承的上下文。
- **明确标识**：输入框上方虚线临时条 + 结束按钮。首条消息后标题变为「临时会话 · HH:mm」，空闲时行首出现图标，标题栏显示「临时」。
- **侧聊不打扰列表**：临时侧聊不出现在侧栏与搜索里，只有提升后才显示。
- **结束与删除**：主区域临时会话可归档隐藏；侧聊关闭标签即丢弃。正常退出 / `SIGTERM` / `SIGINT` 同步删除所有未提升的临时会话目录。
- **崩溃兜底**：进程被强制结束时，下次启动会在浏览器连上之前清掉残留。
- **中英双语**：跟随 DSH 的语言设置。

## 环境要求

- DeepSeek Harness `0.2.x`（声明了 `engines.dsh`；已用 `0.2.1-rc.1` Web profile 及其 Client bundle 验证，Desktop 使用相同的 Host 与 Client 扩展点）。
- 随产品交付的 JSONL 会话存储（`@deepseek-ai/dsh-session-persistence-jsonl`），Web/Desktop 默认即是。无法报告会话目录的后端会在注册时被明确拒绝。

## 安装

仓库本身就是可安装的组合包，没有构建步骤和 `prepare` 脚本。

### Desktop 应用

打开 **设置 → 插件**，添加入口并启用：

```text
github:wj-spec/dsh-temp-session-plugin
```

或用 CLI 装进 desktop profile：

```sh
dsh plugin --profile desktop add 'github:wj-spec/dsh-temp-session-plugin'
```

之后重启应用（或让 profile 热重载生效 Host 行），并刷新页面让浏览器加载 Client 模块。

### Web profile

```sh
dsh plugin --profile web add 'github:wj-spec/dsh-temp-session-plugin'
```

重启 Web 进程并刷新页面。

### 锁定版本

发布 tag 后固定到 tag，避免后续推送改变实际运行的代码：

```sh
dsh plugin --profile web add 'github:wj-spec/dsh-temp-session-plugin#v0.2.2'
```

### 卸载

```sh
dsh plugin --profile web remove dsh-temp-session-plugin
```

## 使用

### 工作区里的临时聊天

1. 悬停工作区行，点右侧的「+」；菜单提供「新会话」和「临时会话」。
2. 选「临时会话」。新会话挂在该工作区，输入框上方出现虚线临时条。
3. 正常聊天。发出第一条消息后，侧栏行标题变为「临时会话 · HH:mm」，标题栏出现「临时」标签。
4. 在输入框上方结束，或直接退出应用；日志会在退出时删除。

也可以先点「新会话」，再在「新会话」行里点「临时」把空白会话标记为临时。

### 选中文字开临时侧聊

1. 打开一个至少有一个已完成回合的会话。
2. 在对话里选中一段文字，浮出的「临时会话」按钮会出现。
3. 点击后，当前会话被 fork 到右侧栏；选中的文字以引用形式预填在输入框里。
4. 在右侧栏继续提问；主会话保持不变。临时期间这个 fork 不出现在侧栏。
5. 点侧聊顶部的「提升为长期会话」保留它；关闭标签则在退出时删除。

可以同时开多个临时会话。侧聊继承父会话到最后一个已完成回合为止的上下文；继承的历史只作为参考，不会继续主任务。

## 工作原理

- **Host**（`index.js`、`core.js`）：记录临时会话 id、类型、直接父会话和 JSONL 返回的精确会话目录；设置标题；side 类型会清掉继承的 goal 并加一段边界提示；负责删除。可变的注册表索引位于 `$DSH_HOME/temp-session/records.json`（权限 `0600`），只追加的所有权日志 `$DSH_HOME/temp-session/ownership.jsonl` 在会话日志落盘前记下临时归属。
- **Web Client**（`client.js`）：注册「新会话」选项、侧栏快捷入口、输入框临时条、标题栏标签、行菜单/徽标、选区浮层、`tempchat` 右侧栏 tab，以及侧栏隐藏过滤器。侧聊 = 普通 `session.fork` + `tempSession/register(kind: "side")`；提升 = `tempSession/promote`，删除临时记录，退出时不再清理。

删除时机：

| 时机 | 行为 |
|---|---|
| 退出应用 / `SIGTERM` / `SIGINT` | 同步删除退出快照中已校验的会话目录；退出时不再解析注册表文件。 |
| 插件卸载 / profile 热重载 | 只删除用户已「结束」的会话，仍在使用的保留。 |
| 下次启动 | 在浏览器连上之前，删除没有存活 Agent 的记录，并清理归档标记。 |

安全边界：

- 主区域临时会话必须是**全新的、空的、顶层、非 fork** 会话；侧聊必须是**子会话自有尾部未使用**的 fork（历史只在继承前缀里）。两者都不能把任意已有历史转成临时，subagent 会话一律拒绝。
- 删除目标必须是绝对路径、至少三层深，且最后一段包含会话 id。
- Host 在已记录的临时会话下创建的 subagent 会自动记录（`kind: "subagent"`），并随该会话一起在退出、丢弃和卸载清理时删除；保留该会话会同时删除这些记录。只有祖先链经由存活的 subagent 会话追溯到已记录 id 时才记录；经过普通 fork 的链，或追溯不到已记录 id 的链，一律不记录。
- 注册表位于 `$DSH_HOME` 下，原子写入。
- 插件不会碰附件，也不会碰其他会话的数据。

## 隐私说明

「临时」指**会话日志会被删除**，而不是完全不落盘：

- 会话期间 DSH 仍会写正常检查点日志，这是流式输出、工具与崩溃恢复的前提。
- 侧聊是 **fork**：它的新日志会复制父会话到分叉点为止的历史。删除侧聊不会影响父会话；如果父会话敏感，请留意这份副本。
- **附件不会删除。** 图片等附件按内容哈希存放在 `$DSH_HOME/attachments/v1`，不按会话归属。需要完全干净时，不要在临时会话里附带敏感文件。
- **投影缓存不会单独清除。** `session_projcache` 里可能留有该会话 id 的一行；日志删除后这行不可达，也不会出现在列表或恢复中，但插件不会物理删除它。
- 被 `SIGKILL`（或断电）结束的进程，日志会一直留到同一 profile 下一次成功启动。

## 已知限制

- 侧聊要求父会话至少有一个**已完成回合**；全新空白会话只会提示，不会 fork。
- 结束主区域临时会话只是归档 + 隐藏，日志要等应用退出才真正删除；关闭侧聊标签同理。DSH `0.2.x` 没有对存活 Agent 的逐会话删除接口。
- 关闭侧聊标签后没有重新打开入口，该临时 fork 会在退出时删除。
- 临时侧聊由客户端过滤出侧栏；刷新页面会从 Host 注册表恢复隐藏集合。删除后它仍会留在工作区的成员 id 列表里（浏览器会按会话列表过滤掉，属无害残留）。
- 远程/移动端没有 `tempSession` Remote 的授权，远程连接创建临时会话会被拒绝。
- 仅支持默认 JSONL 后端。
- UI 依赖 `0.2.x` 的稳定槽位（`conversation.hero.options`、`conversation.session.header.actions`、`conversation.input.dock`、`sidebar.session.row.leading`、`sidebar.right.pane.tab`、`shell.overlay`），以及工作区行末尾的「+」按钮（通过 `data-row-key` 捕获）；未来 DSH 可能调整。

## 验证

- `npm run check`：43 个 Host/Client 测试，无需安装依赖。
- 在一次性 `0.2.1-rc.1` Web profile 上用 Playwright 验证：工作区「+」菜单二选一、侧栏底部无临时入口、选区浮层（hover 不透底）、fork、右侧栏原生会话、引用预填、侧栏隐藏、提升长期、关闭标签丢弃、`SIGTERM` 删除日志、重启清理。
- 未验证：侧聊里真实的模型回复（测试环境没有凭据；fork 来自一个已完成但失败的回合）。Desktop 使用相同的 Host/Client 部件，但没有单独复跑。

## 开发

请务必使用一次性 profile，不要在日常使用的 profile 上开发：

```sh
dsh --profile temp-dev --from-default-profile web --dump-config
dsh plugin --profile temp-dev add /绝对路径/dsh-temp-session-plugin
dsh --profile temp-dev --dump-config
dsh --profile temp-dev
```

测试不需要安装依赖：

```sh
npm test       # Host 清理规则 + Client 接线
npm run check  # 语法检查 + 测试
```

源码结构：

| 文件 | 职责 |
|---|---|
| `index.js` | Host 插件：服务、Remote 注册、启动/信号清理 |
| `core.js` | 注册表、路径安全、同步/异步删除（无 Cordis 依赖） |
| `remote.js` | Host 侧 Typert Remote 描述符 |
| `client.js` | 浏览器模块：入口、徽标、结束操作、提示 |
| `cordis.patch.yml` | 插入 Host 行的 Bundle 层 |
| `locale/*.json` | 插件管理器展示名称与描述 |

## 许可证

MIT，见 [LICENSE](LICENSE)。
