# 交接文档 · dsh-turn-changes

这份文档写给**接手继续开发的人**（很可能是换一台机器后的我自己）。目标是：不看之前的
对话，也能把这个插件讲清楚、装起来、改下去、出问题能定位。

阅读顺序建议：第 1 节（这是什么、现在什么状态）→ 第 6 节（怎么继续开发）→
遇到问题查第 5 节（踩过的坑）和第 9 节（排查表）。第 4 节是平台机制事实，改动插槽、
面板、卡片之前**必读**——那里的每一条都是实测出来的，不是从类型声明推的。

---

## 1. 三十秒版本

| 项 | 值 |
|---|---|
| 插件名 | `dsh-turn-changes`（会话内动态形态叫「回合变更卡」，pluginId 形如 `chgset-1`） |
| 版本 | 1.0.0（= 动态版 v13 的静态化） |
| 宿主半 | `lib/index.js`：订阅 `tools/result` 与 `session/event`，自建行级 diff 引擎，落盘，暴露 `/turn-changes-api/*` |
| 客户端半 | `lib/client.js`：`conversation.chat.turnTail` 上的回合变更卡 + `details` 座位上的右栏审查面板 |
| 状态目录 | `$DSH_HOME/turn-changes/`（`session-<id>.json` + `_status.json`） |
| 离线验证 | `node tools/verify-all.mjs`（宿主半端到端 21 项 + diff 引擎 4012 例 + 配对/高亮 + 计数预测） |
| 已知未完成 | 「撤销」按钮、右栏「工具详情」页签（路线已验证，见 `docs/06-实现-回合变更卡.md` 第十三节） |

它解决的问题：DSH 的会话里，一轮里 AI 改了哪些文件、改了多少、具体改成什么样，原来是散在
工具调用卡片里的。本插件把**每个回合**的改动汇总成一张卡片，并给出一条到行级 diff 的完整路径。

---

## 2. 仓库结构与两种形态

同一个插件在仓库里有两种形态，**逻辑相同、外壳不同**：

```
dynamic/host.js     ──port.mjs──▶  lib/index.js      动态 Cordis 插件（会话内 cordis_define/run）
dynamic/client.js   ──port.mjs──▶  lib/client.js     静态插件（装进 DSH，重启后仍在）
```

- **`dynamic/` = 实验场。** 定义成动态插件后换版本不用重启 DSH，改 UI 迭代最快；
  但动态插件是进程内对象，**DSH 一重启就没了**，换个会话要重新定义。
- **`lib/` = 交付物。** 通过 `package.json` 的 `dsh.bundle.patch` + `dsh.client` 声明，
  由 DSH 的 client-modules 注入浏览器，重启后仍在。
- **`tools/port.mjs` = 两者之间唯一的桥。** 它只做三类替换（外壳 / 通道 / 持久化），
  每个替换点都要求锚点**恰好命中一次**，否则报错退出并不写文件。所以：

> **要改行为，一律改 `dynamic/`，跑 `node tools/port.mjs` 重新生成 `lib/`。**
> 手改 `lib/` 会在下次生成时被覆盖。

`lib/` 与 `dynamic/` 的差异清单（就是 `port.mjs` 干的全部事情）：

| 维度 | dynamic | lib |
|---|---|---|
| 插件体 | `return { inject, apply }` | host: `export default { name, apply }`；client: `window.__ModuleLoader__.load({id, factory})` |
| 客户端↔宿主通道 | `harness.handle(method, fn)` / `host.call(m, args)`（动态插件私有 RPC） | `route(method, fn)` + `webServer` 前缀路由 `/turn-changes-api/<m>` / `fetch` |
| 状态持久化 | `ctx.get('fs')` + **相对路径**（动态插件的 fs 没有工作区授权，只能用相对路径落到进程 cwd） | 直接 `node:fs` 写 `$DSH_HOME/turn-changes` |
| 样式注入 | 内置 `styles.insert(css)` | 自己插 `<style>`，随插件卸载移除 |
| 轮询 | 长轮询（宿主挂起 25s，靠 `timer` 服务） | 立即返回 + 客户端每 1.5s 问一次（去掉 timer 依赖） |

---

## 3. 运行原理

### 3.1 宿主半：事件 → 采集 → 落盘 → 查询

```
session/event(turn/start)          开一个回合的采集桶
tools/result(edit|write)           把 (path, before, after) 记进桶；同一路径多次编辑只保留
                                   首次 before + 末次 after（合并成一次变更）
tools/result(其它写工具)           只标记 sawUntracked = true（卡片出「还有其它写入」提示）
session/event(turn/end)            封存：算行级 diff、算计数、写盘、递增 revision
/turn-changes-api/poll  {since}    返回 revision > since 的所有变更集**摘要**（不含 rows）
/turn-changes-api/get   {sessionId, turn}   某回合的逐文件计数（不含 rows）
/turn-changes-api/review{sessionId, turn}   某回合的逐文件行级 rows（面板点开才取）
/turn-changes-api/diag  {label,value}       客户端把诊断写进宿主日志（见 3.4）
```

关键设计决定（都是被问题逼出来的，见第 5 节）：

1. **计数自己算，不用平台的 hunk 摘要。** 平台的 `result.meta.diffs` 数量与行级改动对不上。
   现在从 `edit`/`write` 拿到的整份文件前后文本自己算 diff，因此
   `additions − deletions ≡ 行数差` 这条不变量恒成立。
2. **行级数据只在点开面板时才传**（`review`），轮询负载里只有计数，避免每 1.5s 搬大 JSON。
3. **落盘是为了跨重启。** 每次封存后写 `session-<id>.json`；启动时读回，历史卡片照旧出现。

### 3.2 客户端半：轮询 → 卡片 → 面板

```
pump() 每 1.5s 调 poll(since=revision)
  ├─ 有新条目 → 记进 changedTurns（turn → 会话集合），并让卡片注册重新求值
  └─ 卡片：注册在 conversation.chat.turnTail 上，select(owner) 命中本回合才渲染
        ├─ 头部：已改动 N 个文件 +A −M，[↺ 撤销(disabled)] [审查]
        ├─ 逐文件行：文件名 + 目录 + +a −m，点行 → 打开右栏并滚到该文件
        └─ 每文件可点「↗ 用系统程序打开」（openFile，由宿主提供）
  └─ 面板：注册在 details 座位上（kind single / scope session）
        ├─ 标题：本条的变更 +A −M，[统一|分栏] [折叠] [加宽/还原] [✕]
        ├─ 文件头（sticky）+ 行级 diff（统一视图两列行号；分栏视图左右两个半栏）
        └─ 无选中时显示引导文案
```

### 3.3 状态格式

`$DSH_HOME/turn-changes/session-<sessionId>.json`：

```jsonc
{
  "version": 1,
  "sessionId": "session-…",
  "revision": 7,                       // 全局递增，客户端靠它增量拉取
  "changeSets": [                      // 每回合一条，最多保留 30 条
    {
      "revision": 7, "sessionId": "…", "turn": 26,
      "files": [
        {
          "path": "reports/x.md", "status": "modified",   // added | modified
          "additions": 66, "deletions": 0,
          "rows": [                                       // 只含改动行 ±3 行上下文
            { "kind": "eq",  "oldNo": 652, "newNo": 652, "text": "…" },
            { "kind": "add", "oldNo": null, "newNo": 655, "text": "…" },
            { "kind": "del", "oldNo": 653, "newNo": null, "text": "…" },
            { "kind": "gap", "oldNo": null, "newNo": null, "text": "", "hidden": 651 }
          ],
          "rowsTruncated": false, "hiddenRows": 0,
          "tooLarge": false, "noRows": false
        }
      ],
      "additions": 66, "deletions": 0,
      "truncated": false,   // 文件数超上限
      "partial": false,     // 有文件太大没算
      "untracked": false    // 本轮有其它写工具
    }
  ]
}
```

`_status.json` 是给排查用的快照（revision、每会话条数、最近日志）。

### 3.4 诊断通道

客户端没有命令行，所以它把关键事实通过 `POST /turn-changes-api/diag` 交给宿主，
宿主 `console.log('[turn-changes] diag.<label> | <value>')` 落到 DSH 日志
（Windows：`%APPDATA%\dsh-desktop\logs\harness.log`）。宿主自己在关键节点也打日志：

```
[turn-changes] stateDir | ready C:\…\harness\turn-changes\.probe
[turn-changes] restored | 4 change sets across 1 sessions
[turn-changes] saved    | session-… sets=4 chars=63568
```

**排查任何问题时先看这三行。**

---

## 4. 平台机制事实（实测）

⚠️ 以下每条都是在真实运行时测出来的（要么来自日志里的报错原文，要么来自 Inspect 的结构契约）。
改动插槽、座位、面板之前先读这里，能省掉大量试错。

### 4.1 用到的插槽

| 插槽 | kind / scope | 用途 | 我们怎么用 |
|---|---|---|---|
| `conversation.chat.turnTail` | chain / turn | 回合末尾的追加位 | 注册**变更卡**，`select(owner)` 命中才渲染 |
| `details` | single / session | 右侧详情列（布局开它才显示） | 注册**审查面板**；拿 `useStore` / `actions` 等 prop |
| `conversation.details.tool` | single / session | 出厂「工具调用详情」的座位 | **不能声明**（见 4.2） |

`details` 列在布局里是网格第三轨：`grid-template-columns: <sidebar>px minmax(0,1fr) <details>px`，
收起是宽度 0（**子树保持挂载**，不是卸载），收起状态挂在 `[data-details-collapsed]` 上。
布局动作由 `ctx.layout` 提供：`openDetails()`（宽度为 0 时设为 360）、`closeDetails()`、`setDetails(n)`。
会话切换时布局会自己关掉该列；会话是 blank 时该列宽度强制为 0。

### 4.2 座位声明的四条规则（重点）

| # | 事实 | 实测证据（原样） |
|---|---|---|
| 1 | 座位声明是**全局**的：一个 key 只能被一个条目声明 | 声明 `conversation.details.tool` → `slot "conversation.details.tool" is already declared (by an entry in "details" (H5))` |
| 2 | `renderSlot(key, props, opts)` **只认本条目自己声明的 children**，不是通用渲染器 | 拿别家座位调用 → `slot 'conversation.details.tool' is not declared by this entry's children` |
| 3 | 声明一个**自己的**、没人占的子座位可以成功，并因此额外拿到 `renderSlot` / `useStore` / `actions` / `SessionProvider` 等 prop | 声明 `conversation.details.review` 后 props 里出现了这四个 |
| 4 | `slots.entriesOfSlot(key)` 能读到同一座位的条目（未文档化）；`slots.isLive` 不存在 | 用它读到了出厂条目的 `component` / `locale` / `store` |

由此得到一条硬结论：**「声明子座位 + 用 renderSlot 渲染出厂工具详情」这条路是死的**（规则 1 与 2
联手封死）。要把出厂的工具详情接回来，只能把座位占用者组件**自己渲染出来**——做法与坑见
`docs/06-实现-回合变更卡.md` 第十三节（需要补 `t`、`useHostInfo`、`SessionProvider`，并套错误边界）。

副产物：**store 句柄可以借**。出厂 `details` 条目上的 `store`（`create` 是函数、`spec` 是
`{init, actions}`）就是那个**每会话共享的 Chat 选择 store**；把它作为自己条目的 `store`，
就能在面板里 `useStore(s => s.selection)` 读到出厂那套「点了哪个工具调用」的状态。

### 4.3 注入与 prop 的对应

- 注册选项里的 `inject: () => ({ hooks: { hostInfo } })`，组件收到的 prop 是 **`useHostInfo`**
  （`hooks.<name>` → `use<Name>`，且是个 hook）。`hostInfo` 的形状是
  `{ getSnapshot: () => ctx.remote.$host, subscribe: (l) => ctx.on('connection/reset', l) }`，
  即标准外部 store，可以用 `React.useSyncExternalStore` 自己包一个等价的。
- `locale: '<ns>'` 会让框架给组件传 `t`；也可以自己 `ctx.get('locale').bind('<ns>')`。
- 动态客户端里 `ctx.get('slots' | 'layout' | 'locale')` 都能拿到；但**静态 bundle 里
  `ctx.get` 只保证读得到 `inject` 声明过的服务**，所以 `lib/client.js` 只声明 `slots`，
  对 `layout` 用 `safeGet` 兜住（缺了只是降级：点「审查」不会开列，但仍会打开文件）。

### 4.4 卡片座位的注册形状

```js
slots.register({
  name: 'conversation.chat.turnTail',
  select: selectClaim,     // (owner) => claim | null，返回 null 就不渲染
  priority: -1
}, ChangedCard)
```

`select` 必须返回**稳定值**（本项目返回 `{ turn }`），否则每次渲染都会重建。

---

## 5. 踩过的坑（症状 → 根因 → 纪律）

1. **一轮里卡片全消失（连历史回合的也没了）。**
   根因：为了给「工具详情」试注册阶梯，重写了 `mount()`，**把卡片那次注册整个丢了**
   ——注册函数里只剩 `details` 那一行。宿主状态一直完好（状态文件里 4 条变更集都在），
   丢的只是「往座位上注册」这一步。
   **纪律：注册函数是清单，不是可以顺手重写的小工具。** 重写它之前先把原有注册逐条列出来对照；
   改完必须**同时**验证卡片与面板两条路径。
   （这一段有完整回退记录：`docs/06-实现-回合变更卡.md` 13.5。）

2. **插件把 DSH 整个搞崩（进程退出 1）。**
   根因：`ctx.fs.writeText(target, <裸字符串>)` 且漏了 `await` —— rejected promise 变成
   unhandled rejection，直接打死宿主（日志：`dsh: fatal load failure`）。
   **纪律：每一个 fs 调用都 `await` + `try/catch`；宿主半里不要留悬空 promise。**

3. **卡片数字与真实改动对不上。**
   根因：早先版本用平台的 hunk 摘要计数，它不是行级的。
   **纪律：计数一律由自己从前后文本算；`additions − deletions ≡ 行数差` 是要守住的不变量。**

4. **写入静默失败、状态目录起不来。**
   根因：动态插件的 fs 没有携带会话工作区授权，写工作区/DSH_HOME 的**绝对路径**会被
   `dsh-fs-sandbox` 拒绝（`FS_SANDBOX_DENIED`），而错误被吞掉了。
   **纪律：动态形态只用相对路径（落到进程 cwd）；静态形态是 DSH 进程本身，用 `node:fs`
   写 `$DSH_HOME` 即可。** 任何写入都要在日志里留下可核对的一行。

5. **加宽后拖分隔条没反应。**
   根因：加宽用的是 `!important` 覆盖网格列，压过了拖拽手柄写回的内联样式。
   **纪律：给了 `!important` 的开关必须自带「还原」按钮**（现在默认加宽，旁边是「还原」）。

6. **点了「统一/分栏」以外的功能就崩/空白。**
   本项目用错误边界包住「借来的外部组件」的渲染（React 类组件 + `getDerivedStateFromError`），
   失败时退回原始文本而不是白屏。**借别人的组件渲染，永远要有一层兜底。**

7. **预测卡片数字偏大。**
   根因：预测时把「文件被创建了」当成「文件被工具写了」——只有 `edit` / `write` **工具调用**
   才会被采集，脚本自己 `writeFileSync` 写盘的文件不进卡片。
   **纪律：预测与采集必须使用同一口径。**

8. **换版本后 UI 没变化。**
   根因：动态插件换 package 后，旧条目的注册要等新 fiber 挂载；`mount()` 里必须先释放旧注册，
   否则会同时存在两次注册（`single` 座位只渲染胜者，表现为「有时生效有时不生效」）。
   **纪律：每次注册前先 `try { registration() } catch {}` 释放旧注册。**

9. **`Get-Content` 数行不准、`Select-Object -First N` 让 node 退出码 1。**
   这些是观测工具的问题，不是插件的：行数用 node 数；管道里提前截断会触发 EPIPE，
   让被截断的进程以 1 退出 —— 别把它当失败。

---

## 6. 怎么继续开发

### 6.1 改行为（推荐路径）

```
1. 改 dynamic/host.js 或 dynamic/client.js
2. 在会话里定义并激活（不用重启 DSH）
     cordis_define({ plugin: {kind:'existing', pluginId:'<你自己的>'}, code:{host, client} })
     cordis_run({ pluginId, packageId, mode:'update' })
3. 看效果 + 读日志核对（宿主 console → harness.log；浏览器控制台看客户端报错）
4. node tools/port.mjs        # 重新生成 lib/
5. node tools/verify-all.mjs  # 离线回归
6. 静态形态要生效：重装（node install.mjs）并重启 DSH
```

改完第 2 步记得**两条路径都验**：卡片（回合尾部）+ 面板（右栏）——第 5.1 条的教训。

### 6.2 只改文档或验证脚本

直接改，跑 `node tools/verify-all.mjs`。

### 6.3 版本与发布

- 改 `package.json` 的 `version`；版本历史记在 `CHANGELOG.md`；
- 大的设计取舍、实测结论、回退记录都写进 `docs/06-实现-回合变更卡.md`（那一份是完整的技术日志）；
- 提交前跑验证 + 过一遍第 7 节的验收清单。

---

## 7. 验收清单

**离线（不需要装插件）**

```bash
node tools/verify-all.mjs
```

| 脚本 | 覆盖什么 | 期望 |
|---|---|---|
| `verify/verify-static-host.mjs` | 静态宿主半端到端：假 ctx 驱动 事件 → diff → 落盘 → HTTP 四问，再用新 ctx apply 一次验证历史读回 | `passed=21 failed=0` |
| `verify/verify-line-diff.mjs` | 行级 diff 引擎与平台 `diff@9.0.0` 对拍 + 结构重建/行号自洽/折叠守恒 | `用例总数：4012 … ALL PASS` |
| `verify/verify-pairing.mjs` | 分栏配对、词级高亮（读真实落盘的 rows） | `ALL PASS (含合成用例)` |
| `verify/predict.mjs` | 卡片计数预测器（宿主同口径） | 输出 `PLUGIN_EXPECT=+A -M` |

`verify-pairing` 需要一份真实状态文件：不传参数时自动找
`$DSH_HOME/turn-changes/session-*.json`（没有就 SKIP，不算失败）。

**装机后（人工，逐条对现象）**

| # | 动作 | 应看到的 |
|---|---|---|
| 1 | 让 DSH 改一个文件，回合结束 | 该回合消息下方出现「已改动 N 个文件 +A −M」卡片 |
| 2 | 点卡片「审查」 | 右侧 details 列展开，列出该回合全部文件 |
| 3 | 对照 `git diff --numstat` | 卡片数字一致（或 `node verify/predict.mjs <前> <后>` 对账） |
| 4 | 切「分栏」 | 删除行与新增行同行成对，配对行内部有词级高亮 |
| 5 | 重启 DSH | 卡片仍在（历史从 `$DSH_HOME/turn-changes` 读回） |
| 6 | 看 DSH 日志 | `[turn-changes] stateDir | ready …`、`restored | N change sets …`、每次封存有 `saved | …` |
| 7 | 浏览器控制台 | 无报错；`fetch('/turn-changes-api/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"since":0}'}).then(r=>r.json()).then(console.log)` 有 JSON 返回 |

---

## 8. 未完成项与已知限制

**没做的功能**

1. **「撤销」按钮**存在但 `disabled`：真撤销要改写工作区文件（且要处理部分撤销、冲突），
   当前只做到「如实汇总」，不做写回。按钮保留是为了让你知道这个位置将来放什么。
2. **右栏「工具详情」页签**未合入。目标：把我的面板变成「审查 / 工具详情」两个页签，
   后者展示出厂的工具调用详情（点会话里任一工具调用就跟着变）。路线已验证可行：
   借出厂 store 拿到选择态 → 用 `slots.entriesOfSlot('conversation.details.tool')` 取到
   占用者组件 → 手工装配 props（标准 props + `block`/`cwd` + `locale` 的 `t` +
   `hooks.hostInfo` 包出的 `useHostInfo`，套 `SessionProvider`，外套错误边界）。
   自检过一次 `mounted-ok`（用真实工具块渲染没抛错）。**做的时候务必保留卡片注册**（第 5.1 条）。
3. 自动打开右栏（新回合封存时自动展开并选中）曾实现过，因与卡片回归一起回退**未合入**。
   要重做的话：`ctx.layout.openDetails()` + 选中该回合，并限制「首次轮询（历史恢复）不触发」。

**已知限制（接受现状）**

1. **静态客户端半没有在本机装过**：它的逻辑与动态版逐字相同（差异只有通道与外壳，见第 2 节），
   宿主半是端到端验证过的，但「装进 DSH 后浏览器里表现如何」需要你在装机后按第 7 节验收。
   这是这份交接里最需要注意的一条。
2. 只有 `edit` / `write` 计入卡片；其它写工具（bash/pwsh/python…）只出「本轮还有其它写入」提示。
3. 上限：单文件 >20000 行不算 diff；单文件最多存 4000 行 rows；单回合最多 4000 行；
   每会话内存保留 40 个回合、落盘 30 个；单回合最多 200 个文件。
4. 词级高亮分词器是 jsdiff `diffWordsWithSpace` 的等价实现（LCS + token 上限，替代 Myers + `timeout:20`）：
   高亮**边界可能相差一个 token**，视觉无影响，但不是逐字节等同。
5. 明暗两套 diff 配色**没有目检过**：机制（主题属性切换）与色值来源都核实了，
   渲染结果没看到。改样式时顺便看一眼。
6. 状态目录变了：动态版写在进程 cwd 的 `launch-root/turn-changes`，静态版写在
   `$DSH_HOME/turn-changes`。**老历史不会自动迁移**，需要的话手动拷：

   ```powershell
   Copy-Item "$env:APPDATA\dsh-desktop\launch-root\turn-changes\session-*.json" `
             "$env:APPDATA\dsh-desktop\harness\turn-changes\"
   ```
7. 默认路径是 Windows 的 `D:\DSH Desktop\resources\app`（`DSH_APP_DIR` 可覆盖）；
   验证脚本对拍用的 `diff@9.0.0` 取自本机 DSH 自带的 node_modules。
8. 动态形态一重启就没了 —— 要长期存在必须静态安装。

---

## 9. 排查表

| 症状 | 先看什么 | 多半是什么 / 怎么修 |
|---|---|---|
| 会话底部没有卡片 | ① `harness.log` 有没有 `saved` ② `$DSH_HOME/turn-changes` 有没有 `session-*.json` ③ 客户端有没有注册 `turnTail` | 有 `saved` 但没卡片 → **注册丢了**（第 5.1 条），检查注册清单；没有 `saved` → 采集没发生，看宿主是否收到 `tools/result` / `session/event` |
| 卡片数字不对 | `node verify/predict.mjs <前> <后>` | 口径不一致：卡片只统计 `edit`/`write`；用到会改文件的 shell 工具时只看得到计数不完整的提示 |
| 点「审查」右栏不开 | 卡片有点到吗？`/turn-changes-api/review` 有没有返回 `found:true` | `layout` 服务没读到（静态 bundle 只声明了 `slots`，用 `safeGet` 兜底）→ 会退化成用系统程序打开文件 |
| 右栏空白 / 只有引导文案 | `poll` 返回的 entries 里有没有该 turn；状态文件里有没有该回合 | 面板要的是「当前会话 + 选中回合」，会话不匹配就只显示引导文案 |
| 装了没反应 | `dsh plugin list`；`$DSH_HOME/generations/desired.json`；重启过 DSH 吗 | 客户端 bundle 只在启动时注入；确认 `package.json` 里 `dsh.client.platform = web` 与 `cordis.patch.yml` 的插入行 |
| 浏览器里完全没有插件的痕迹 | 网络面板 `/plugins/dsh-turn-changes/client.js` 是否 200 | bundle 没被 client-modules 发现：检查 `exports['./client']` 与 `dsh.bundle.patch` |
| 日志里 `stateDir | unavailable` | 那行后面的具体错误 | 写 `$DSH_HOME` 失败：路径不存在/无权限，`node:fs` 会自己建目录，多半是 `DSH_HOME` 指错了 |
| 重启后历史丢了 | `restored | N change sets` 的 N | N=0 说明状态文件没读到：确认 `$DSH_HOME` 与写盘时一致（换过 DSH_HOME 就会这样） |

---

## 10. 与 Cindy 的对应关系

| 本插件的部分 | 移植自 Cindy | 备注 |
|---|---|---|
| 行级 diff 配色、整行上色、上下文行不上色 | `PlainUnifiedDiff.tsx` | 浅/深两套色值 + 两个 emphasis 色 |
| 分栏配对（删除行与新增行同行成对） | `diffRows.ts:284-297` `pairChangedLines` | 连续改动行收成 `deletes[]`/`adds[]` 后按下标配对，行数取 max |
| 词级高亮的四项门槛与区间合并 | `inlineDiff.ts`、`highlight.ts` | 单行 1000 字符 / 公共比例 0.3 / 150 配对 / 20 万字符 |
| 分词器 | jsdiff `diffWordsWithSpace` | 等价重写，非逐字节等同 |
| 交互（回合尾部卡片 → 右侧审查栏） | 应用层交互 | 结构照搬，落地到 DSH 的插槽体系 |

Cindy 以 Apache-2.0 发布（Copyright 2026 XD Inc.，https://github.com/makecindy/cindy ），
署名要求见仓库根目录的 `NOTICE`。**本仓库不包含 Cindy 的源代码**，上述移植是行为等价的重写。

---

## 11. 相关文档索引

| 文档 | 内容 |
|---|---|
| `README.md` | 对外说明：能做什么、怎么装、怎么验收 |
| `HANDOVER.md` | 本文档 |
| `docs/06-实现-回合变更卡.md` | 完整技术日志：机制实测、每一版为什么这么改、v14–v18 的探索与 13.5 的回退记录 |
| `dynamic/README.md` | 两种形态的关系、`port.mjs` 的替换清单 |
| `verify/*.mjs` | 离线验证脚本（自带中文说明头） |
| `CHANGELOG.md` | 版本历史 |
