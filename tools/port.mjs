// dsh-turn-changes — 形态移植器
//
// 为什么要有这个脚本：这个插件有两种形态，逻辑必须一模一样。
//   dynamic/  —— 会话内动态插件形态（Cordis 动态包）的源。改行为、看效果都在这里迭代，
//                因为动态插件不用重启 DSH 就能换版本。它按部件存放：dynamic/<half>/index.json
//                列出拼接顺序，部件之间共享同一个函数作用域（会话内由加载器拼接后执行）。
//   lib/      —— 静态插件形态（可安装、重启后仍在）。它是从 dynamic/ 机械生成的。
//
// 于是「改一次、两边一致」靠的不是人肉同步，而是这个脚本：改完 dynamic/ 跑一次
//   node tools/port.mjs
// 就重新生成 lib/。所有替换都要求锚点唯一命中，锚点对不上脚本直接失败——
// 这样 dynamic/ 结构性改动之后不会静默生成出一个坏掉的 lib/。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ok = []
const bad = []

/**
 * 行尾统一成 LF。
 *
 * 为什么必须做：JS 规范规定模板字面量源码里的 `<CR><LF>` 在解析时被规范化成 `<LF>`，
 * 而 readFileSync 读出来的是原样字节。于是在 Windows 上用默认 core.autocrlf=true 克隆
 * 下来的仓库里（源码是 CRLF），本文件里「带换行的锚点」一律匹配不上，单行锚点却正常 ——
 * 这个坑在全新克隆的复现测试里实测踩到过（10 个多行锚点全部命中 0 次）。
 * 所以：比较前两边都统一成 LF，输出也一律 LF。
 */
function lf(text) {
  return text.replace(/\r\n/g, '\n')
}

/**
 * 按 dynamic/<half>/index.json 拼接部件，得到该半的完整函数体。
 * 这是两半源码的唯一读取口：动态形态下由会话内的加载器做同样的拼接后执行，
 * 静态形态下由本脚本拼接后移植。行尾在这里统一成 LF，见上面的 lf 说明。
 */
function assemble(half) {
  const dir = join('dynamic', half)
  const parts = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(dir + '/index.json 不是非空数组')
  }
  // 每段规整成「去掉尾部空白 + 恰好一个换行」再直接相接：部件必须是完整语句，
  // 这样拼接结果与「一个文件写完」逐字一致（部件之间不会多出空行，锚点才稳）。
  const chunks = parts.map((part) => readFileSync(join(dir, part), 'utf8').replace(/\s*$/, '') + '\n')
  return lf(chunks.join(''))
}

/** 精确替换一次；命中 0 次或多次都算失败。 */
function replaceOnce(text, anchor, replacement, label) {
  const hay = lf(text)
  const needle = lf(anchor)
  const count = hay.split(needle).length - 1
  if (count !== 1) {
    bad.push(label + ' — 锚点命中 ' + count + ' 次（要求恰好 1 次）')
    return hay
  }
  ok.push(label)
  const parts = hay.split(needle)
  return parts[0] + lf(replacement) + parts.slice(1).join(needle)
}

/** 全局替换，并记录命中次数（0 次同样算失败）。 */
function replaceAll(text, from, to, label) {
  const hay = lf(text)
  const needle = lf(from)
  const count = hay.split(needle).length - 1
  if (count === 0) {
    bad.push((label === undefined ? from : label) + ' — 命中 0 次')
    return hay
  }
  ok.push((label === undefined ? from : label) + ' ×' + count)
  return hay.split(needle).join(lf(to))
}

// ─────────────────────────── host ───────────────────────────

function portHost(source) {
  let text = source

  text = replaceOnce(text, `return {
  inject: ['timer'],
  apply(ctx) {`, `// dsh-turn-changes host half —— 静态版。
// ⚠ 本文件由 tools/port.mjs 从 dynamic/host.js 生成，不要手改；改 dynamic/host.js 后重新生成。
//
// 与动态版的差异只有三处，其余（工作区事件订阅、行级 diff 引擎、计数不变量、
// 落盘格式）与 dynamic/host.js 逐字相同：
//   1. 动态版用 harness 的方法注册通道 → 静态版换成 route(method, fn) + 一条 webServer 前缀路由
//      /turn-changes-api/<method>，客户端半用 fetch 调用（静态世界里没有动态插件私有的 host.call）。
//   2. ctx.get('fs') 服务 → 直接用 node:fs 读写 $DSH_HOME/turn-changes。
//      动态版只能写进程 cwd 下的相对路径（沙箱限制），静态版是 DSH 进程本身，可以写自己的家目录。
//   3. 去掉长轮询等待者：poll 立即返回，客户端每 1.5s 问一次（不再依赖 timer 服务）。
import { join, dirname } from 'node:path'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

export default {
  name: 'dsh-turn-changes',
  apply(ctx) {`, 'host/外壳：包成静态插件（imports + export default）')

  text = replaceOnce(text, `    const POLL_TIMEOUT_MS = 25000`, `    // 插件私有状态的根目录。与 install-thinking-effort.mjs 同款取法。
    const STATE_ROOT = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(process.env.APPDATA === undefined ? process.cwd() : process.env.APPDATA, 'dsh-desktop', 'harness')`, 'host/常量：POLL_TIMEOUT_MS → STATE_ROOT')

  text = replaceOnce(text, `    const waiters = []`, `    // 静态版没有等待者（poll 立即返回）；相关分支已由本脚本移除。`, 'host/删除 waiters')

  text = replaceOnce(text, `    let fsService = null
    let stateDirPromise = null`, `    // 方法表：动态版是 harness.handle(method, fn)，静态版换成这张表 + 一条 HTTP 前缀路由。
    const routes = new Map()
    function route(method, handler) {
      routes.set(method, handler)
      return () => { routes.delete(method) }
    }

    let fsService = null
    let stateDirPromise = null`, 'host/加入 route 方法表')

  text = replaceOnce(text, `    function getFs() {
      if (fsService !== null) return fsService
      let candidate = null
      try {
        candidate = ctx.get('fs')
      } catch (err) {
        note('fs.get', String(err))
        return null
      }
      if (candidate === null || candidate === undefined) {
        note('fs', 'absent')
        return null
      }
      if (typeof candidate.resolve !== 'function' || typeof candidate.writeText !== 'function' || typeof candidate.readText !== 'function' || typeof candidate.listDir !== 'function') {
        note('fs.shape', 'resolve=' + typeof candidate.resolve + ' writeText=' + typeof candidate.writeText + ' readText=' + typeof candidate.readText + ' listDir=' + typeof candidate.listDir)
        return null
      }
      fsService = candidate
      return fsService
    }`, `    function getFs() {
      if (fsService !== null) return fsService
      // 形状故意与动态版用到的 fs 服务一致（resolve / writeText / readText / listDir），
      // 这样上层 stateDir/saveSession/restoreAll/writeStatus 一个字都不用改。
      function absolute(path) {
        const text = String(path)
        return /^[A-Za-z]:[\\\\/]/.test(text) || text.startsWith('/') ? text : join(STATE_ROOT, text)
      }
      function target(path) {
        const file = absolute(path)
        return { displayPath: file, absolute: file }
      }
      fsService = {
        resolve: async (path) => target(path),
        writeText: async (where, text) => {
          mkdirSync(dirname(where.absolute), { recursive: true })
          writeFileSync(where.absolute, String(text), 'utf8')
        },
        readText: async (where) => readFileSync(where.absolute, 'utf8'),
        listDir: async (where) => readdirSync(where.absolute, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          target: target(join(where.absolute, entry.name))
        }))
      }
      return fsService
    }`, 'host/持久化：fs 服务 → node:fs')

  text = replaceOnce(text, `    function releaseWaiters(closed) {
      const flushing = waiters.splice(0, waiters.length)
      for (const waiter of flushing) {
        try { waiter.dispose() } catch (err) { /* ignore */ }
        try {
          waiter.resolve({
            revision: revision,
            entries: entriesSince(waiter.since),
            closed: closed === true,
            timeout: false
          })
        } catch (err) { /* ignore */ }
      }
    }`, `    // 静态版没有等待者；保留空实现，让 seal() 与卸载路径的调用点与动态版保持一致。
    function releaseWaiters(closed) {
      void closed
    }`, 'host/releaseWaiters → 空实现')

  return text
}

// 读入时按 index.json 拼接部件并统一行尾（见上面的 lf 说明），
// 保证无论仓库以 LF 还是 CRLF 检出都得到同一结果。
let host = portHost(assemble('host'))

host = replaceAll(host, 'harness.handle(', 'route(', 'host/通道：harness.handle → route')

host = replaceOnce(host, `    ctx.effect(() => route('turn-changes/poll', (args) => {
      const since = args !== null && typeof args === 'object' && typeof args.since === 'number' ? args.since : 0
      const entries = entriesSince(since)
      if (entries.length > 0 || disposed) {
        return { revision: revision, entries: entries, closed: disposed, timeout: false }
      }
      return new Promise((resolve) => {
        const waiter = { since: since, resolve: resolve, dispose: () => {} }
        waiter.dispose = ctx.timeout(() => {
          const index = waiters.indexOf(waiter)
          if (index !== -1) waiters.splice(index, 1)
          resolve({ revision: revision, entries: entriesSince(since), closed: disposed, timeout: true })
        }, POLL_TIMEOUT_MS)
        waiters.push(waiter)
      })
    }))`, `    // 静态版不做长轮询：立即返回，客户端每 1.5s 问一次（见 lib/client.js 的 POLL_INTERVAL_MS）。
    ctx.effect(() => route('turn-changes/poll', (args) => {
      const since = args !== null && typeof args === 'object' && typeof args.since === 'number' ? args.since : 0
      return { revision: revision, entries: entriesSince(since), closed: disposed, timeout: false }
    }))`, 'host/poll：长轮询 → 立即返回')

host = replaceOnce(host, `    ctx.effect(() => () => {
      disposed = true
      releaseWaiters(true)
    })`, `    // 静态版的客户端通道：一条前缀路由 + 方法分发（写法与 dsh-file-attach 的 /fdrop-api 相同）。
    ctx.inject(['webServer'], (serverCtx) => {
      serverCtx.effect(() => serverCtx.webServer.register({
        kind: 'prefix',
        path: '/turn-changes-api',
        handler: async (req, res) => {
          function send(body, status) {
            const payload = JSON.stringify(body)
            res.writeHead(status === undefined ? 200 : status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(payload)
            })
            res.end(payload)
          }
          try {
            if (req.method !== 'POST') {
              send({ error: 'POST only' }, 405)
              return
            }
            const url = new URL(req.url || '/', 'http://turn-changes.local')
            const method = url.pathname.slice('/turn-changes-api/'.length).replace(/\\/+$/, '')
            const handler = routes.get('turn-changes/' + method)
            if (handler === undefined) {
              send({ error: 'unknown method: ' + method }, 404)
              return
            }
            const raw = await new Promise((resolve, reject) => {
              const chunks = []
              req.on('data', (chunk) => { chunks.push(chunk) })
              req.on('end', () => { resolve(chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8')) })
              req.on('error', reject)
            })
            let args = {}
            if (raw !== '') {
              try {
                args = JSON.parse(raw)
              } catch (err) {
                send({ error: 'bad json' }, 400)
                return
              }
            }
            send(await handler(args))
          } catch (err) {
            send({ error: err instanceof Error ? err.message : String(err) }, 500)
          }
        }
      }), 'dsh-turn-changes: /turn-changes-api routes')
    })

    ctx.effect(() => () => {
      disposed = true
      releaseWaiters(true)
    })`, 'host/加入 webServer 前缀路由')

if (host.endsWith('\n') === false) host += '\n'

// ─────────────────────────── client ───────────────────────────

function portClient(source) {
  let text = source

  text = replaceOnce(text, `return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const layout = ctx.get('layout')`, `// dsh-turn-changes client half —— 静态浏览器 bundle。
// ⚠ 本文件由 tools/port.mjs 从 dynamic/client.js 生成，不要手改；改 dynamic/client.js 后重新生成。
//
// 与动态版的差异只有通道与外壳，插槽注册、卡片、右栏面板、分栏配对与词级高亮算法逐字相同：
//   1. 外壳：window.__ModuleLoader__.load({id, factory}) 工厂式注册（静态客户端插件的标准形态）。
//   2. 动态版的 host.call 私有通道 → fetch POST /turn-changes-api/<m>。
//   3. 内置样式服务的 insert → 自己插 <style> 元素，随插件卸载移除。
//   4. ctx.timeout(...) 退避 → 直接 sleep，配合宿主「立即返回」的 poll 每 1.5s 问一次。
window.__ModuleLoader__.load({
  id: 'dsh-turn-changes',
  factory: function (require) {
    const React = require('react')

    // host 通道：静态世界里没有动态插件私有的 host.call。
    async function apiCall(method, args) {
      const response = await fetch('/turn-changes-api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args === undefined ? {} : args)
      })
      if (response.ok !== true) throw new Error('turn-changes-api HTTP ' + response.status)
      return await response.json()
    }

    // 静态 bundle 里只保证 inject 声明的服务可读；可选依赖一律兜住，缺了只降级、不致命。
    function safeGet(ctx, name) {
      try {
        return ctx.get(name)
      } catch (err) {
        return undefined
      }
    }

    function insertStyles(ctx, css) {
      const el = document.createElement('style')
      el.setAttribute('data-dsh-turn-changes', '')
      el.textContent = String(css)
      document.head.appendChild(el)
      ctx.effect(() => () => { if (el.isConnected) el.remove() })
    }

    const POLL_INTERVAL_MS = 1500
    function sleep(ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms) })
    }

    return {
      name: 'dsh-turn-changes',
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        const layout = safeGet(ctx, 'layout')`, 'client/外壳：ModuleLoader 工厂 + 通道助手')

  text = replaceOnce(text, `    const RETRY_DELAY_MS = 2000\n`, ``, 'client/删除 RETRY_DELAY_MS')
  text = replaceAll(text, `styles.insert(`, `insertStyles(ctx, `, 'client/样式：内置 styles.insert → insertStyles')
  text = replaceAll(text, `host.call(`, `apiCall(`, 'client/通道：host.call → apiCall')

  text = replaceOnce(text, `        } else {
          await new Promise((resolve) => { ctx.timeout(() => resolve(null), RETRY_DELAY_MS) })
        }
      }
    }`, `        }
        // 静态版的 poll 立即返回，所以每轮都要显式等一拍，否则会打成热循环。
        await sleep(POLL_INTERVAL_MS)
      }
    }`, 'client/pump：退避等待 → 固定间隔轮询')

  text = replaceOnce(text, `    ctx.effect(() => () => { stopped = true })
  }
}`, `        ctx.effect(() => () => { stopped = true })
      }
    }
  }
})
`, 'client/收尾：闭合工厂与 ModuleLoader.load')

  return text
}

// 读入时先统一行尾（见文件开头的 lf 说明），保证无论仓库以 LF 还是 CRLF 检出都得到同一结果。
const client = portClient(assemble('client'))

if (bad.length > 0) {
  console.error('移植失败，未写出任何文件：')
  for (const line of bad) console.error('  ✗ ' + line)
  process.exit(1)
}

writeFileSync('lib/index.js', lf(host))
writeFileSync('lib/client.js', lf(client))

console.log('已生成 lib/index.js（' + host.split('\n').length + ' 行）与 lib/client.js（' + client.split('\n').length + ' 行）')
console.log('替换点 ' + ok.length + ' 个：')
for (const line of ok) console.log('  ✓ ' + line)
