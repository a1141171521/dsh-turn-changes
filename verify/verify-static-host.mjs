// dsh-turn-changes — 静态宿主半的离线验证。
//
// 这里不装插件、不重启 DSH：给 lib/index.js 一个假的 ctx（effect/on/inject/get）、
// 一个假的 webServer，然后按真实顺序驱动它：
//   session/event(turn/start) → tools/result(edit ×2) → session/event(turn/end)
//   → POST /turn-changes-api/{poll,get,review}
// 最后用一个新的 ctx 再 apply 一次，验证落盘的历史能被读回。
//
// 覆盖到的点：行级 diff 与计数不变量、同一文件多次编辑的合并、write 新文件、
// 未追踪写入的横幅标记、node:fs 持久化、HTTP 路由分发与 JSON 形状。
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'turn-changes-verify-'))
process.env.DSH_HOME = HOME

const SESSION = 'session-verify'
let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition === true) {
    passed += 1
    console.log('  PASS  ' + label)
  } else {
    failed += 1
    console.log('  FAIL  ' + label + (detail === undefined ? '' : '  ← ' + detail))
  }
}

function lines(text) {
  if (text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').length
}

/** 一个够用的假 Cordis ctx。 */
function makeCtx() {
  const events = new Map()
  const effects = []
  const registered = []
  const ctx = {
    on(event, fn) {
      const list = events.get(event) || []
      list.push(fn)
      events.set(event, list)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    get() {
      return undefined
    },
    inject(names, callback) {
      callback({
        effect: ctx.effect,
        webServer: {
          register(spec) {
            registered.push(spec)
            return () => {}
          }
        }
      })
    }
  }
  return {
    ctx,
    registered,
    emit(event, ...args) {
      for (const fn of events.get(event) || []) fn(...args)
    }
  }
}

function makeReq(body) {
  const listeners = new Map()
  return {
    method: 'POST',
    url: '/turn-changes-api/x',
    on(event, fn) {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
      return this
    },
    fire() {
      setTimeout(() => {
        if (body !== undefined && body !== '') for (const fn of listeners.get('data') || []) fn(Buffer.from(body, 'utf8'))
        for (const fn of listeners.get('end') || []) fn()
      }, 0)
    }
  }
}

function makeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(text) {
      state.body = text === undefined ? '' : String(text)
    }
  }
}

/** 允许非 200 的原始调用（用于测错误路径）。 */
async function callRaw(route, method, args) {
  const req = makeReq(JSON.stringify(args))
  req.url = '/turn-changes-api/' + method
  const res = makeRes()
  const pending = route.handler(req, res)
  req.fire()
  await pending
  return { status: res.state.status, body: JSON.parse(res.state.body === '' ? '{}' : res.state.body) }
}

async function callApi(route, method, args) {
  const req = makeReq(JSON.stringify(args))
  req.url = '/turn-changes-api/' + method
  const res = makeRes()
  const pending = route.handler(req, res)
  req.fire()
  await pending
  if (res.state.status !== 200) throw new Error('HTTP ' + res.state.status + ': ' + res.state.body)
  return JSON.parse(res.state.body)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ─────────────────────────── 第一次 apply：采集并落盘 ───────────────────────────

const { default: plugin } = await import('../lib/index.js')

check('插件导出形状正确', plugin !== null && plugin.name === 'dsh-turn-changes' && typeof plugin.apply === 'function', String(plugin && plugin.name))

const first = makeCtx()
plugin.apply(first.ctx)

check('注册了 /turn-changes-api 前缀路由', first.registered.length === 1 && first.registered[0].path === '/turn-changes-api' && first.registered[0].kind === 'prefix', JSON.stringify(first.registered.map((r) => r.path)))
const route = first.registered[0]

const BEFORE = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n'
const MIDDLE = 'line1\nline2\nline3\nline4-CHANGED\nline5\nline6\nline7\nline8\n'
const AFTER = 'line1\nline2\nline3\nline4-CHANGED\nline5\nline6\nline7\nline8\nline9\n'

const exec = { name: 'edit', agent: { id: SESSION } }

first.emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: 7 } })
// 同一文件两次编辑：卡片必须按 before(第一次) → after(最后一次) 计一次。
first.emit('tools/result', exec, { isError: false, value: { path: 'docs/a.md', before: BEFORE, after: MIDDLE } })
first.emit('tools/result', exec, { isError: false, value: { path: 'docs/a.md', before: MIDDLE, after: AFTER } })
// write 新文件：before 缺省 → status=added。
first.emit('tools/result', { name: 'write', agent: { id: SESSION } }, { isError: false, value: { path: 'notes/new.txt', after: 'hello\nworld\n' } })
// 会改工作区但无法精确追踪的工具 → 横幅标记。
first.emit('tools/result', { name: 'pwsh', agent: { id: SESSION } }, { isError: false, value: {} })
first.emit('session/event', { id: SESSION }, { type: 'turn/end', data: { turn: 7 } })

await sleep(400)

const stateFiles = readdirSync(join(HOME, 'turn-changes'))
check('状态目录已建立并写入会话文件', stateFiles.indexOf(SESSION + '.json') !== -1, stateFiles.join(','))
check('写入了 _status.json', stateFiles.indexOf('_status.json') !== -1, stateFiles.join(','))

const review = await callApi(route, 'review', { sessionId: SESSION, turn: 7 })
check('review 找到该回合', review.found === true, JSON.stringify(review).slice(0, 120))
check('review 返回两个文件', Array.isArray(review.files) && review.files.length === 2, 'files=' + (review.files || []).length)

const a = (review.files || []).filter((f) => f.path === 'docs/a.md')[0]
check('a.md 同一回合两次编辑合并成一次变更', a !== undefined && a.additions === 2 && a.deletions === 1, a === undefined ? 'missing' : '+' + a.additions + ' -' + a.deletions)
check('a.md 计数不变量：additions − deletions ≡ 行数差', a !== undefined && a.additions - a.deletions === lines(AFTER) - lines(BEFORE), a === undefined ? 'missing' : 'delta=' + (a.additions - a.deletions) + ' expected=' + (lines(AFTER) - lines(BEFORE)))
check('a.md 带行级 rows', a !== undefined && Array.isArray(a.rows) && a.rows.length > 0, a === undefined ? 'missing' : 'rows=' + (a.rows || []).length)
const changedRows = (a === undefined ? [] : a.rows).filter((r) => r.kind === 'del' || r.kind === 'add')
check('a.md 改动行数 = additions + deletions', changedRows.length === a.additions + a.deletions, 'changed=' + changedRows.length + ' vs ' + (a.additions + a.deletions))

const n = (review.files || []).filter((f) => f.path === 'notes/new.txt')[0]
check('write 新文件被记为 added', n !== undefined && n.status === 'added' && n.additions === 2 && n.deletions === 0, JSON.stringify(n))
check('回合计数不变量：合计 = 各文件之和', review.additions === (a.additions + n.additions) && review.deletions === (a.deletions + n.deletions), '+' + review.additions + ' -' + review.deletions)
check('未追踪写入触发 untracked 横幅', review.untracked === true, String(review.untracked))

const got = await callApi(route, 'get', { sessionId: SESSION, turn: 7 })
check('get 不带 rows（卡片只取计数）', got.found === true && got.files[0].rows === undefined, JSON.stringify(got.files[0]).slice(0, 90))

const polled = await callApi(route, 'poll', { since: 0 })
check('poll 立即返回该变更集', polled.entries.length === 1 && polled.entries[0].turn === 7 && polled.timeout === false, JSON.stringify(polled).slice(0, 120))

const empty = await callApi(route, 'poll', { since: polled.revision })
check('poll 用最新 revision 再问返回空', empty.entries.length === 0, JSON.stringify(empty))

const unknown = await callRaw(route, 'nosuch', {})
check('未知方法返回 404 且不抛错', unknown.status === 404 && typeof unknown.body.error === 'string', JSON.stringify(unknown))

// ─────────────────────────── 第二次 apply：从磁盘恢复 ───────────────────────────

const second = makeCtx()
plugin.apply(second.ctx)
await sleep(400)

const restoredRoute = second.registered[0]
const restored = await callApi(restoredRoute, 'review', { sessionId: SESSION, turn: 7 })
check('重启后（新 apply）历史变更集被读回', restored.found === true && restored.files.length === 2, JSON.stringify(restored).slice(0, 120))

const restoredPoll = await callApi(restoredRoute, 'poll', { since: 0 })
check('恢复的历史会随第一次轮询送出', restoredPoll.entries.length === 1 && restoredPoll.entries[0].turn === 7, JSON.stringify(restoredPoll.entries))

// ─────────────────────────── 状态文件形状 ───────────────────────────

const sessionFile = JSON.parse(readFileSync(join(HOME, 'turn-changes', SESSION + '.json'), 'utf8'))
check('会话文件版本化且带 changeSets', sessionFile.version === 1 && Array.isArray(sessionFile.changeSets) && sessionFile.changeSets.length === 1, JSON.stringify(Object.keys(sessionFile)))
check('状态目录可读且路径为 $DSH_HOME/turn-changes', readdirSync(join(HOME, 'turn-changes')).length >= 3, readdirSync(join(HOME, 'turn-changes')).join(','))

rmSync(HOME, { recursive: true, force: true })
console.log('')
console.log('passed=' + passed + ' failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
