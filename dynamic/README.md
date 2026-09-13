# dynamic/ —— 动态插件形态（会话内快速迭代用）

这两个文件是同一个插件的**动态 Cordis 插件形态**：

| 文件 | 是什么 |
|---|---|
| `host.js` | 宿主半的插件体：`return { inject, apply(ctx) {...} }`，跑在 DSH 进程里 |
| `client.js` | 浏览器半的插件体：同样是一个 `apply(ctx)`，跑在页面里 |

它们**不是**可以直接 `node` 运行的模块，而是交给 DSH 的 Cordis 动态插件工具去定义与激活：

```
cordis_define({ plugin: { kind: 'new', idPrefix: 'chgset' }, name: '回合变更卡', purpose: '...',
                code: { host: <dynamic/host.js 的全文>, client: <dynamic/client.js 的全文> } })
cordis_run({ pluginId: '<返回的 id>', packageId: '<返回的 packageId>', mode: 'run' })
```

## 什么时候用这个形态

- **改 UI / 改算法时**：`cordis_define` + `cordis_run` 换一个 package 就生效，**不用重启 DSH**，
  所以在这里迭代最快。
- 动态包是进程内对象：**DSH 一重启就没了**，而且换一个会话就要重新定义一次。
  要长期在机器上存在，得用静态形态（`lib/`）。

## 两个形态的关系（重要）

`lib/index.js` 与 `lib/client.js` 是**由这两个文件机械生成**的：

```
node tools/port.mjs
```

`tools/port.mjs` 只做三类替换，且每个替换点都要求锚点唯一命中（对不上就报错退出，不写任何文件）。
它**与行尾无关**：比较前两边都归一成 LF，所以 LF / CRLF 检出的仓库都能生成同样的 `lib/`；
回归测试见 `verify/verify-port-crlf.mjs`（把源码复制成 CRLF 再跑一遍，逐字节比对）。

1. **外壳**：动态的插件体 → 静态插件（host: `export default {name, apply}`；client: `window.__ModuleLoader__.load({id, factory})`）。
2. **通道**：`harness.handle(method, fn)` → `route(method, fn)` + 一条 `webServer` 前缀路由；
   `host.call(m, args)` → `fetch POST /turn-changes-api/<m>`。
3. **持久化**：`ctx.get('fs')` 服务 → 直接 `node:fs` 读写 `$DSH_HOME/turn-changes`。

其余部分（事件订阅、行级 diff 引擎、计数不变量、落盘格式、卡片与面板、分栏配对与词级高亮）
**逐字相同**。所以：**要改行为一律改 `dynamic/`，然后跑 `node tools/port.mjs` 重新生成 `lib/`**，
不要手改 `lib/`（改了下次生成就被覆盖）。
