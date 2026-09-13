// dsh-turn-changes host half —— 静态版。
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
  apply(ctx) {
    const MAX_FILES_PER_TURN = 200
    const KEEP_TURNS_PER_SESSION = 40
    // 插件私有状态的根目录。与 install-thinking-effort.mjs 同款取法。
    const STATE_ROOT = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(process.env.APPDATA === undefined ? process.cwd() : process.env.APPDATA, 'dsh-desktop', 'harness')
    const CONTEXT_LINES = 3
    const MAX_LCS_SIDE = 600
    const MAX_LINES_FOR_DIFF = 20000
    const MAX_ROWS_PER_FILE = 4000
    const MAX_ROWS_PER_TURN = 4000
    const MAX_PERSIST_TURNS = 30
    const MAX_PERSIST_CHARS = 6000000

    // 会直接或间接改动工作区的工具名。这台机器上执行命令的工具叫 pwsh
    // （@deepseek-ai/dsh-tool-pwsh），必须显式列上，否则横幅会漏报。
    const WRITE_CAPABLE_TOOL = /bash|shell|exec|terminal|powershell|pwsh|cmd|python|node/i

    // 关键结论（实测得出，见 harness.log 里的 [turn-diag]）：
    // 插件的 fs 没有携带会话的 workspace 授权，所以对工作区与 DSH_HOME 的
    // 绝对路径写入会被 dsh-fs-sandbox 拒绝（FS_SANDBOX_DENIED）。
    // 但相对路径会被解析到沙箱允许的根（进程 cwd，即 userData/launch-root）下，
    // 写入成功且子目录会自动创建。因此状态一律用相对路径，不硬编码任何机器路径。
    const STATE_DIR = 'turn-changes'
    const STATUS_NAME = '_status.json'

    const pending = new Map()
    const sealed = new Map()
    // 静态版没有等待者（poll 立即返回）；相关分支已由本脚本移除。
    let revision = 0
    let disposed = false

    // 同时写进宿主 console（落到 logs/harness.log），这样持久化层出了任何问题
    // 都能从日志里直接读到，而不是只能猜。
    const notes = []
    function note(label, value) {
      const text = label + ' | ' + String(value)
      if (notes.length < 80) notes.push(text)
      try { console.log('[turn-changes] ' + text) } catch (err) { /* ignore */ }
    }

    // 方法表：动态版是 route(method, fn)，静态版换成这张表 + 一条 HTTP 前缀路由。
    const routes = new Map()
    function route(method, handler) {
      routes.set(method, handler)
      return () => { routes.delete(method) }
    }

    let fsService = null
    let stateDirPromise = null

    function getFs() {
      if (fsService !== null) return fsService
      // 形状故意与动态版用到的 fs 服务一致（resolve / writeText / readText / listDir），
      // 这样上层 stateDir/saveSession/restoreAll/writeStatus 一个字都不用改。
      function absolute(path) {
        const text = String(path)
        return /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') ? text : join(STATE_ROOT, text)
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
    }

    function errorText(err) {
      if (err === null || err === undefined) return 'null'
      const name = err.name === undefined ? '?' : String(err.name)
      const code = err.code === undefined ? '-' : String(err.code)
      const message = err.message === undefined ? String(err) : String(err.message)
      return name + '/' + code + ': ' + message
    }

    // 每一条 fs 调用都必须 await 并 catch：
    // 曾经因为漏掉 await，一个 rejected promise 变成 unhandled rejection，
    // 直接把整个宿主进程打死（harness.log: "dsh: fatal load failure"）。
    function stateDir() {
      if (stateDirPromise !== null) return stateDirPromise
      stateDirPromise = (async () => {
        const fs = getFs()
        if (fs === null) return null
        try {
          const target = await fs.resolve(STATE_DIR + '/.probe')
          await fs.writeText(target, 'ok')
          const back = await fs.readText(target)
          if (typeof back !== 'string' || back.indexOf('ok') !== 0) throw new Error('round trip returned ' + typeof back)
          note('stateDir', 'ready ' + String(target.displayPath))
          return STATE_DIR
        } catch (err) {
          note('stateDir', 'unavailable: ' + errorText(err))
          return null
        }
      })()
      return stateDirPromise
    }

    async function writeStatus(extra) {
      try {
        const fs = getFs()
        if (fs === null) return
        const dir = stateDirPromise === null ? null : await stateDirPromise
        if (dir === null) return
        const counts = []
        for (const pair of sealed.entries()) counts.push(String(pair[0]) + '=' + pair[1].length)
        const payload = {
          at: new Date().toISOString(),
          revision: revision,
          sessions: counts,
          notes: notes.slice(0, 80),
          extra: extra === undefined ? null : extra
        }
        const target = await fs.resolve(STATE_DIR + '/' + STATUS_NAME)
        await fs.writeText(target, JSON.stringify(payload, null, 2))
      } catch (err) { /* 状态文件只是诊断，失败不影响功能 */ }
    }

    async function saveSession(sessionId) {
      try {
        const fs = getFs()
        if (fs === null) return
        const dir = await stateDir()
        if (dir === null) return
        const list = sealed.get(sessionId)
        if (list === undefined || list.length === 0) return
        const trimmed = list.slice(Math.max(0, list.length - MAX_PERSIST_TURNS))
        let text = ''
        for (let attempt = 0; attempt < 40; attempt += 1) {
          text = JSON.stringify({ version: 1, sessionId: sessionId, revision: revision, changeSets: trimmed })
          if (text.length <= MAX_PERSIST_CHARS || trimmed.length <= 1) break
          trimmed.shift()
        }
        const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
        const target = await fs.resolve(STATE_DIR + '/' + safe + '.json')
        await fs.writeText(target, text)
        note('saved', safe + ' sets=' + trimmed.length + ' chars=' + text.length)
      } catch (err) {
        note('saveError', errorText(err))
      }
    }

    async function restoreAll() {
      try {
        const fs = getFs()
        if (fs === null) return 0
        const dir = await stateDir()
        if (dir === null) return 0
        const dirTarget = await fs.resolve(dir)
        const entries = await fs.listDir(dirTarget)
        if (!Array.isArray(entries)) {
          note('listDir', 'not an array')
          return 0
        }
        let restored = 0
        let maxRevision = 0
        for (const entry of entries) {
          const name = entry !== null && typeof entry === 'object' ? entry.name : null
          if (typeof name !== 'string') continue
          if (name.slice(-5) !== '.json' || name.charAt(0) === '_' || name.charAt(0) === '.') continue
          let entryTarget = entry !== null && typeof entry === 'object' && entry.target !== undefined ? entry.target : null
          if (entryTarget === null) {
            try {
              entryTarget = await fs.resolve(dir + '/' + name)
            } catch (err) {
              note('resolveFailed', name + ' :: ' + errorText(err))
              continue
            }
          }
          let text = null
          try {
            text = await fs.readText(entryTarget)
          } catch (err) {
            note('readFailed', name + ' :: ' + errorText(err))
            continue
          }
          let parsed = null
          try {
            parsed = JSON.parse(text)
          } catch (err) {
            note('parseFailed', name + ' :: ' + errorText(err))
            continue
          }
          if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.changeSets)) continue
          const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : null
          if (sessionId === null || sessionId === '') continue
          const list = []
          for (const changeSet of parsed.changeSets) {
            if (changeSet === null || typeof changeSet !== 'object') continue
            if (typeof changeSet.turn !== 'number' || !Array.isArray(changeSet.files)) continue
            if (typeof changeSet.revision === 'number' && changeSet.revision > maxRevision) maxRevision = changeSet.revision
            list.push(changeSet)
            restored += 1
          }
          if (list.length > 0) sealed.set(sessionId, list)
        }
        if (maxRevision > revision) revision = maxRevision
        note('restored', restored + ' change sets across ' + sealed.size + ' sessions')
        return restored
      } catch (err) {
        note('restoreError', errorText(err))
        return 0
      }
    }

    // 与平台 contentLines 同一条行模型：空文本 0 行，末尾换行是终止符而非多一行。
    function splitLines(text) {
      if (typeof text !== 'string' || text === '') return []
      const body = text.endsWith('\n') ? text.slice(0, -1) : text
      return body.split('\n')
    }

    function pathKey(path) {
      return path.replace(/\\/g, '/').toLowerCase()
    }

    function lcsOps(a, b) {
      const out = []
      if (a.length === 0) {
        for (const text of b) out.push({ kind: 'add', text: text })
        return out
      }
      if (b.length === 0) {
        for (const text of a) out.push({ kind: 'del', text: text })
        return out
      }
      if (a.length > MAX_LCS_SIDE || b.length > MAX_LCS_SIDE) {
        for (const text of a) out.push({ kind: 'del', text: text })
        for (const text of b) out.push({ kind: 'add', text: text })
        return out
      }
      const n = a.length
      const m = b.length
      const width = m + 1
      const table = new Int32Array((n + 1) * width)
      for (let i = n - 1; i >= 0; i -= 1) {
        const row = i * width
        const next = (i + 1) * width
        for (let j = m - 1; j >= 0; j -= 1) {
          if (a[i] === b[j]) table[row + j] = table[next + j + 1] + 1
          else table[row + j] = table[next + j] >= table[row + j + 1] ? table[next + j] : table[row + j + 1]
        }
      }
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          out.push({ kind: 'eq', text: a[i] })
          i += 1
          j += 1
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
          out.push({ kind: 'del', text: a[i] })
          i += 1
        } else {
          out.push({ kind: 'add', text: b[j] })
          j += 1
        }
      }
      while (i < n) {
        out.push({ kind: 'del', text: a[i] })
        i += 1
      }
      while (j < m) {
        out.push({ kind: 'add', text: b[j] })
        j += 1
      }
      return out
    }

    function buildDiff(beforeText, afterText) {
      const a = splitLines(beforeText)
      const b = splitLines(afterText)
      if (a.length > MAX_LINES_FOR_DIFF || b.length > MAX_LINES_FOR_DIFF) {
        return { tooLarge: true, additions: null, deletions: null, rows: [], rowsTruncated: false, hiddenRows: 0 }
      }
      let start = 0
      while (start < a.length && start < b.length && a[start] === b[start]) start += 1
      let endA = a.length
      let endB = b.length
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1
        endB -= 1
      }

      const ops = []
      let oldNo = 1
      let newNo = 1
      for (let i = 0; i < start; i += 1) {
        ops.push({ kind: 'eq', oldNo: oldNo, newNo: newNo, text: a[i] })
        oldNo += 1
        newNo += 1
      }
      const mid = lcsOps(a.slice(start, endA), b.slice(start, endB))
      let additions = 0
      let deletions = 0
      for (const op of mid) {
        if (op.kind === 'eq') {
          ops.push({ kind: 'eq', oldNo: oldNo, newNo: newNo, text: op.text })
          oldNo += 1
          newNo += 1
        } else if (op.kind === 'del') {
          ops.push({ kind: 'del', oldNo: oldNo, newNo: null, text: op.text })
          oldNo += 1
          deletions += 1
        } else {
          ops.push({ kind: 'add', oldNo: null, newNo: newNo, text: op.text })
          newNo += 1
          additions += 1
        }
      }
      for (let i = endA; i < a.length; i += 1) {
        ops.push({ kind: 'eq', oldNo: oldNo, newNo: newNo, text: a[i] })
        oldNo += 1
        newNo += 1
      }

      const keep = new Array(ops.length).fill(false)
      for (let i = 0; i < ops.length; i += 1) {
        if (ops[i].kind === 'eq') continue
        const from = i - CONTEXT_LINES < 0 ? 0 : i - CONTEXT_LINES
        const to = i + CONTEXT_LINES > ops.length - 1 ? ops.length - 1 : i + CONTEXT_LINES
        for (let j = from; j <= to; j += 1) keep[j] = true
      }
      const rows = []
      let hidden = 0
      for (let i = 0; i < ops.length; i += 1) {
        if (keep[i]) {
          if (hidden > 0) {
            rows.push({ kind: 'gap', oldNo: null, newNo: null, text: '', hidden: hidden })
            hidden = 0
          }
          rows.push(ops[i])
        } else hidden += 1
      }
      if (hidden > 0) rows.push({ kind: 'gap', oldNo: null, newNo: null, text: '', hidden: hidden })

      let rowsTruncated = false
      let hiddenRows = 0
      if (rows.length > MAX_ROWS_PER_FILE) {
        hiddenRows = rows.length - MAX_ROWS_PER_FILE
        rows.length = MAX_ROWS_PER_FILE
        rowsTruncated = true
      }
      return { tooLarge: false, additions: additions, deletions: deletions, rows: rows, rowsTruncated: rowsTruncated, hiddenRows: hiddenRows }
    }

    function lineCount(text) {
      return splitLines(text).length
    }

    function bucketFor(sessionId) {
      let bucket = pending.get(sessionId)
      if (bucket === undefined) {
        bucket = { files: new Map(), overflow: false, sawUntracked: false }
        pending.set(sessionId, bucket)
      }
      return bucket
    }

    // fresh 表示「本次回合还没捕获过这个文件的第一个 before」。
    // 不能在建条目时就当成已捕获，否则真正的 before 永远不会写入。
    function entryFor(bucket, path) {
      const key = pathKey(path)
      let entry = bucket.files.get(key)
      if (entry === undefined) {
        if (bucket.files.size >= MAX_FILES_PER_TURN) {
          bucket.overflow = true
          return null
        }
        entry = { path: path, before: null, after: '', fresh: true, noRows: false, additions: 0, deletions: 0 }
        bucket.files.set(key, entry)
      }
      return entry
    }

    ctx.on('tools/result', (exec, result) => {
      try {
        if (exec === null || typeof exec !== 'object') return
        if (result === null || typeof result !== 'object') return
        const name = exec.name
        if (typeof name !== 'string' || name === '') return
        const agent = exec.agent
        const sessionId = agent !== null && typeof agent === 'object' ? agent.id : undefined
        if (typeof sessionId !== 'string' || sessionId === '') return
        const bucket = bucketFor(sessionId)

        if (name !== 'edit' && name !== 'write') {
          // Cindy 同款诚实机制：本轮只要有会写文件的命令类工具，就标记为不精确完整。
          if (result.isError !== true && WRITE_CAPABLE_TOOL.test(name)) bucket.sawUntracked = true
          return
        }
        if (result.isError === true) return

        const value = result.value
        if (value !== null && typeof value === 'object') {
          const path = value.path
          const after = value.after
          if (typeof path === 'string' && path !== '' && typeof after === 'string') {
            const rawBefore = value.before
            const before = rawBefore === undefined || rawBefore === null ? null : (typeof rawBefore === 'string' ? rawBefore : null)
            const entry = entryFor(bucket, path)
            if (entry === null) return
            if (entry.fresh === true) {
              entry.fresh = false
              entry.before = before
            }
            entry.after = after
            return
          }
        }

        // 防御性回退：拿不到整份文件时，仍从 meta.diffs 记录计数（平台口径），
        // 并标记该文件没有行级 diff，绝不静默丢掉一个改动过的文件。
        const meta = result.meta
        if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return
        const raw = meta.diffs
        if (!Array.isArray(raw)) return
        for (const hunk of raw) {
          if (hunk === null || typeof hunk !== 'object') continue
          const path = hunk.path
          if (typeof path !== 'string' || path === '') continue
          const oldText = typeof hunk.oldText === 'string' ? hunk.oldText : null
          const newText = typeof hunk.newText === 'string' ? hunk.newText : ''
          const entry = entryFor(bucket, path)
          if (entry === null) continue
          if (entry.fresh === true) entry.fresh = false
          entry.noRows = true
          entry.additions += lineCount(newText)
          if (oldText !== null) entry.deletions += lineCount(oldText)
        }
      } catch (err) {
        console.error('[turn-changes] capture failed: ' + String(err))
      }
    })

    function sealOne(entry, budget) {
      if (entry.fresh === true) return null
      if (entry.noRows === true) {
        return {
          path: entry.path,
          status: entry.before === null && entry.after !== '' ? 'added' : 'modified',
          additions: entry.additions,
          deletions: entry.deletions,
          rows: [],
          rowsTruncated: false,
          hiddenRows: 0,
          tooLarge: false,
          noRows: true
        }
      }
      const diff = buildDiff(entry.before, entry.after)
      let rows = diff.rows
      let rowsTruncated = diff.rowsTruncated
      let hiddenRows = diff.hiddenRows
      if (rows.length > budget) {
        hiddenRows += rows.length - budget
        rows = rows.slice(0, budget)
        rowsTruncated = true
      }
      return {
        path: entry.path,
        status: entry.before === null ? 'added' : 'modified',
        additions: diff.tooLarge ? null : diff.additions,
        deletions: diff.tooLarge ? null : diff.deletions,
        rows: rows,
        rowsTruncated: rowsTruncated,
        hiddenRows: hiddenRows,
        tooLarge: diff.tooLarge === true,
        noRows: false,
        rowCount: diff.rows.length
      }
    }

    function seal(sessionId, turn, bucket) {
      if (bucket.files.size === 0) return
      const entries = Array.from(bucket.files.values())
      entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      const files = []
      let additions = 0
      let deletions = 0
      let partial = false
      let budget = MAX_ROWS_PER_TURN
      for (const entry of entries) {
        const file = sealOne(entry, budget)
        if (file === null) continue
        if (typeof file.rowCount === 'number') {
          budget -= file.rowCount
          if (budget < 0) budget = 0
          delete file.rowCount
        }
        if (file.tooLarge === true) partial = true
        else {
          additions += file.additions
          deletions += file.deletions
        }
        files.push(file)
      }
      if (files.length === 0) return
      revision += 1
      const changeSet = {
        revision: revision,
        sessionId: sessionId,
        turn: turn,
        files: files,
        additions: additions,
        deletions: deletions,
        truncated: bucket.overflow === true,
        partial: partial,
        untracked: bucket.sawUntracked === true,
        rebuilt: false
      }
      const list = sealed.get(sessionId)
      if (list === undefined) sealed.set(sessionId, [changeSet])
      else {
        list.push(changeSet)
        while (list.length > KEEP_TURNS_PER_SESSION) list.shift()
      }
      saveSession(sessionId)
      releaseWaiters(false)
    }

    ctx.on('session/event', (session, event) => {
      try {
        if (session === null || typeof session !== 'object') return
        if (event === null || typeof event !== 'object') return
        const sessionId = session.id
        if (typeof sessionId !== 'string' || sessionId === '') return
        const type = event.type
        if (type !== 'turn/start' && type !== 'turn/end') return
        const data = event.data
        const turn = data !== null && typeof data === 'object' ? data.turn : undefined
        if (type === 'turn/start') {
          pending.set(sessionId, { files: new Map(), overflow: false, sawUntracked: false })
          return
        }
        const bucket = pending.get(sessionId)
        pending.delete(sessionId)
        if (bucket === undefined || typeof turn !== 'number') return
        seal(sessionId, turn, bucket)
      } catch (err) {
        console.error('[turn-changes] turn tracking failed: ' + String(err))
      }
    })

    function entriesSince(since) {
      const out = []
      for (const list of sealed.values()) {
        for (const changeSet of list) {
          if (changeSet.revision <= since) continue
          out.push({
            sessionId: changeSet.sessionId,
            turn: changeSet.turn,
            fileCount: changeSet.files.length,
            additions: changeSet.additions,
            deletions: changeSet.deletions
          })
        }
      }
      return out
    }

    // 静态版没有等待者；保留空实现，让 seal() 与卸载路径的调用点与动态版保持一致。
    function releaseWaiters(closed) {
      void closed
    }

    function findChangeSet(sessionId, turn) {
      const list = sealed.get(sessionId)
      if (list === undefined) return null
      let found = null
      for (const changeSet of list) if (changeSet.turn === turn) found = changeSet
      return found
    }

    function changeSetPayload(found, withRows) {
      const files = []
      for (const file of found.files) {
        const item = {
          path: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          tooLarge: file.tooLarge,
          noRows: file.noRows
        }
        if (withRows === true) {
          item.rows = file.rows
          item.rowsTruncated = file.rowsTruncated
          item.hiddenRows = file.hiddenRows
          item.noNumbers = file.noNumbers === true
          item.rebuilt = file.rebuilt === true
        }
        files.push(item)
      }
      return {
        found: true,
        sessionId: found.sessionId,
        turn: found.turn,
        additions: found.additions,
        deletions: found.deletions,
        truncated: found.truncated,
        partial: found.partial,
        untracked: found.untracked,
        rebuilt: found.rebuilt === true,
        files: files
      }
    }

    // 静态版不做长轮询：立即返回，客户端每 1.5s 问一次（见 lib/client.js 的 POLL_INTERVAL_MS）。
    ctx.effect(() => route('turn-changes/poll', (args) => {
      const since = args !== null && typeof args === 'object' && typeof args.since === 'number' ? args.since : 0
      return { revision: revision, entries: entriesSince(since), closed: disposed, timeout: false }
    }))

    ctx.effect(() => route('turn-changes/get', (args) => {
      if (args === null || typeof args !== 'object') return { found: false }
      const sessionId = args.sessionId
      const turn = args.turn
      if (typeof sessionId !== 'string' || typeof turn !== 'number') return { found: false }
      const found = findChangeSet(sessionId, turn)
      if (found === null) return { found: false }
      return changeSetPayload(found, false)
    }))

    // 面板按需取整条消息的行级 diff；不进长轮询负载。
    ctx.effect(() => route('turn-changes/review', (args) => {
      if (args === null || typeof args !== 'object') return { found: false }
      const sessionId = args.sessionId
      const turn = args.turn
      if (typeof sessionId !== 'string' || typeof turn !== 'number') return { found: false }
      const found = findChangeSet(sessionId, turn)
      if (found === null) return { found: false }
      return changeSetPayload(found, true)
    }))

    // 启动时把落盘的历史变更集读回内存，随后任何一次轮询都会把它们送给客户端。
    restoreAll().then((count) => {
      writeStatus()
      if (count > 0) releaseWaiters(false)
    }).catch((err) => {
      note('restoreFatal', errorText(err))
      writeStatus()
    })

    // 静态版的客户端通道：一条前缀路由 + 方法分发（写法与 dsh-file-attach 的 /fdrop-api 相同）。
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
            const method = url.pathname.slice('/turn-changes-api/'.length).replace(/\/+$/, '')
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
    })
  }
}
