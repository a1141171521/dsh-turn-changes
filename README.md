# dsh-turn-changes（回合变更卡）

给 DSH 加一条「这一轮到底改了什么」的完整审查路径：**每个回合在会话底部出一张变更卡，
点卡片上的「审查」，右侧 details 栏列出该回合所有文件的行级 diff。**

```
   ┌─ 会话 ────────────────────────────┐┌─ details 栏 ──────────────────┐
   │  …                                ││ 本条的变更        +72  −6      │
   │  ┌──────────────────────────────┐ ││ 统一 | 分栏 | 折叠 | 加宽      │
   │  │ 🗎 已改动 3 个文件  +72 −6    │ ││ ────────────────────────────  │
   │  │   card.js       +40 −2       │ ││  card.js                       │
   │  │   host.js  src/ +32 −4       │ ││  611 611   const a = 1         │
   │  │      ↺ 撤销   审查           │ ││  612      - const b = 2        │
   │  └──────────────────────────────┘ ││  612 612  + const b = 3        │
   └───────────────────────────────────┘└───────────────────────────────┘
```

- 计数只算**改动行**（与 git / Cindy 同口径）：新增 `+A`、删除 `−M`，且始终满足
  `A − M ≡ 文件行数变化`。
- 行级 diff 由插件自己从整份文件的前后文本算，不依赖平台给出的 hunk 摘要。
- diff 视图的配色、分栏配对、词级高亮照搬 Cindy（见 `NOTICE`）：整行挂红/绿底色 +
  上下文行不上色，分栏时删除行与新增行**同行成对**，配对行内部做词级 emphasis。

## 安装

```bash
# 方式一：仓库自带安装脚本（复用 DSH Desktop 的 generation 安装管线）
node install.mjs                       # 默认 D:\DSH Desktop\resources\app
node install.mjs "D:\你的DSH\resources\app"

# 方式二：用 dsh 自带的插件命令
dsh plugin --profile web add <本仓库绝对路径>
```

装完**重启 DSH**（客户端 bundle 在启动时注入页面）。卸载：把
`$DSH_HOME/generations/desired.json` 里这一代删掉再重启。

## 装完怎么验收

1. 让 DSH 改一个文件（编辑或新建都行），回合结束。
2. 会话底部出现「已改动 N 个文件 +A −M」卡片 —— 出现在**这一回合的消息下面**。
3. 点卡片上的「审查」→ 右侧展开，显示该回合的逐文件行级 diff。
4. 卡片上的 `+A −M` 与真实改动一致（`git diff --numstat`，或 `node verify/predict.mjs <前> <后>` 对账）。
5. 「分栏」视图下删除行与新增行同行成对；配对行内部有词级高亮。
6. 重启 DSH 后卡片仍在（历史从 `$DSH_HOME/turn-changes/` 读回）。

## 开发

```bash
node tools/verify-all.mjs      # 离线验证：宿主半端到端 + 行级 diff 引擎 + 配对/高亮 + 计数预测
node tools/port.mjs           # 从 dynamic/ 重新生成 lib/（改完 dynamic/ 后必跑）
```

**改行为一律改 `dynamic/`，再跑 `node tools/port.mjs`。** 仓库里同一个插件有两种形态：

| 目录 | 形态 | 用途 |
|---|---|---|
| `dynamic/` | 动态 Cordis 插件（会话内定义） | 快速迭代：换版本不用重启 DSH，但**重启即失效** |
| `lib/` | 静态插件（可安装） | 长期存在的形态；由 `tools/port.mjs` 从 `dynamic/` 生成，**不要手改** |

两者除「外壳 / 通道 / 持久化」三处外逐字相同，细节见 `dynamic/README.md`。

## 目录

```
lib/index.js        宿主半（静态）：订阅 tools/result 与 session/event，行级 diff 引擎，
                    落盘 $DSH_HOME/turn-changes，暴露 /turn-changes-api/*
lib/client.js       浏览器半（静态）：回合尾部卡片 + 右侧 details 栏面板
dynamic/host.js     上面两个文件的源形态（动态插件版）
dynamic/client.js
tools/port.mjs      dynamic/ → lib/ 的机械移植器（锚点对不上就报错）
tools/verify-all.mjs 一次跑完全部离线验证
verify/             离线验证脚本（不需要装插件、不需要重启 DSH）
docs/               实现记录：机制实测、每一版为什么这么改、回退记录
HANDOVER.md         交接文档：架构、平台机制事实、踩过的坑、未完成项、排查表
```

## 已知限制（诚实清单）

- 「撤销」按钮存在但是 `disabled`：真撤销要改写工作区文件，目前不做。
- 右侧栏的「工具详情」页签（把出厂的工具调用详情接回来）**未合入**这一版；
  路线已实测可行，做法与坑记在 `docs/06-实现-回合变更卡.md` 第十三节。
- 只有能精确拿到前后文本的 `edit` / `write` 会计入卡片；其它会改文件的工具（bash/pwsh/
  python…）只在卡片上出「本轮还有其它写入」的提示，不猜数字。
- 大文件与大回合有上限：单文件 >20000 行不做行级 diff、单文件最多存 4000 行、单回合最多
  4000 行、每会话保留 40 个回合（落盘 30 个）。
- 词级高亮的分词器是按 jsdiff 行为重写的等价实现，不是逐字节等同（高亮边界可能差一个 token）。
- 默认路径是 Windows 的 `D:\DSH Desktop\resources\app`；换机器设 `DSH_APP_DIR`。

## 许可与署名

本仓库代码以 MIT 发布；diff 视图的设计与算法移植自 Cindy（Apache-2.0，Copyright 2026
XD Inc.），署名见 `NOTICE`。本仓库不包含 Cindy 的源代码。
