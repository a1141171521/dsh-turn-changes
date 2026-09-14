# dynamic/ —— 动态插件形态（会话内快速迭代用）

这里是同一个插件的**动态 Cordis 插件形态**源码。它不是一个整文件，而是**按部件存放**：

| 路径 | 是什么 |
|---|---|
| `host/index.json` | 宿主半的部件顺序表 |
| `host/00-core.js` | 宿主半插件体：轮询、写入追踪、行级 diff 引擎、落盘、`harness.handle` 方法表 |
| `client/index.json` | 客户端半的部件顺序表 |
| `client/00-core.js` | 客户端半：样式、diff 渲染、`ReviewPanel`、`ChangedCard` |
| `client/50-sidebar.js` | 右侧栏外壳（页签栏、页签表、错误边界、顶部按钮） |
| `client/90-mount.js` | 两处挂载（回合尾卡片、右栏、顶部按钮）与轮询泵 |
| `client/95-close.js` | 收尾花括号（拼接后闭合 `apply` 与插件对象） |

## 为什么要拆成部件

动态插件是**进程内对象**：每个版本都要以源码文本形式提交一次（`cordis_define` 的入参），
改一行 UI 也要把整份源码重新发一遍。拆成部件后：

- 仓库文件是**唯一源码**，改哪块只动哪块；
- 会话内由一个**开发加载器**（`tools/loader.mjs`）按 `index.json` 拼接后在两半分别 `new Function` 执行；
- 迭代 = 改仓库文件 → 重启加载器包（`cordis_run` 同一个 `packageId`、`mode:'run'`），
  不必重新提交源码。注册与副作用都挂在加载器那条 fiber 上，重启会先干净地销毁上一次的全部注册。

部件之间**共享同一个函数作用域**（拼接后是同一个函数体），所以可以自由共用变量与函数。
规则只有两条：**每个部件都必须是完整语句**（不能在字符串或表达式中间断开）；
`const`/`let` 不提升，所以定义在前、使用在后（函数声明会提升，不受影响）。

## 静态形态怎么来

`lib/index.js` 与 `lib/client.js` 是**由这些部件机械生成**的：

```
node tools/port.mjs
```

`tools/port.mjs` 先按 `index.json` 拼接（`assemble()`），再做三类替换，每个替换点都要求锚点唯一命中
（对不上就报错退出，不写任何文件）。它**与行尾无关**：比较前两边都归一成 LF，所以 LF / CRLF
检出的仓库都能生成同样的 `lib/`；回归测试见 `verify/verify-port-crlf.mjs`
（把源码复制成 CRLF 再跑一遍，逐字节比对）。

1. **外壳**：动态的插件体 → 静态插件（host: `export default {name, apply}`；client: `window.__ModuleLoader__.load({id, factory})`）。
2. **通道**：`harness.handle(method, fn)` → `route(method, fn)` + 一条 `webServer` 前缀路由；
   `host.call(m, args)` → `fetch POST /turn-changes-api/<m>`。
3. **持久化**：`ctx.get('fs')` 服务 → 直接 `node:fs` 读写 `$DSH_HOME/turn-changes`。

其余部分（事件订阅、行级 diff 引擎、计数不变量、落盘格式、卡片与右侧栏）**逐字相同**。
所以：**要改行为一律改 `dynamic/`，然后跑 `node tools/port.mjs` 重新生成 `lib/`**，
不要手改 `lib/`（改了下次生成就被覆盖）。
