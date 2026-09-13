/**
 * 验证 chgset-1/pkg-6 自建的行级 diff 引擎。
 *
 * pkg-6 不再依赖平台的 hunk 计数，而是自己从整份文件前后文本算真实 unified diff。
 * 自建引擎必须自证，所以用平台自己的 diff@9.0.0 对拍，并做结构重建：
 *
 *  1. 重建：从 ops 分别推出「旧文本」与「新文本」，必须逐行等于输入 —— 这是最强的一条，
 *     因为它同时证明了 del/add 的归属、顺序与行号推进。
 *  2. 编辑脚本不变量：additions − deletions ≡ 行数差。
 *  3. 折叠守恒：Σ gap.hidden + 非 gap 行数 ≡ ops 行数（折叠不丢行也不多行）。
 *  4. 行号自洽：ops 上出现的最大旧/新行号 ≡ 两侧行数。
 *  5. 最小脚本规模：本引擎的 (additions + deletions) 等于 diffLines 的规模。
 *     （最小脚本的规模唯一；两个最小算法可以选出不同脚本，但规模必然相同。）
 *
 * 运行： node verify/verify-line-diff.mjs
 *
 * 换机器：本脚本用 DSH 自带的第三方 diff@9.0.0 做对拍，默认按 D:\DSH Desktop\resources\app
 * 找它；装在别处就设 DSH_APP_DIR 指向 DSH 安装目录的 resources\app。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const DIFF_PKG = join(
  process.env.DSH_APP_DIR !== undefined && process.env.DSH_APP_DIR !== ''
    ? process.env.DSH_APP_DIR
    : 'D:/DSH Desktop/resources/app',
  'node_modules',
  'diff'
)
let diffPkg
try {
  diffPkg = require(DIFF_PKG)
} catch (err) {
  diffPkg = require(DIFF_PKG + '/libcjs/index.cjs')
}
const { diffLines } = diffPkg
if (typeof diffLines !== 'function') {
  throw new Error('diffLines unavailable; exports = ' + Object.keys(diffPkg).join(', '))
}

// ─────────── 与 Host 半部逐字一致的转写 ───────────
const CONTEXT_LINES = 3
const MAX_LCS_SIDE = 600
const MAX_LINES_FOR_DIFF = 20000
const MAX_ROWS_PER_FILE = 4000

function splitLines(text) {
  if (typeof text !== 'string' || text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
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
    if (a[i] === b[j]) { out.push({ kind: 'eq', text: a[i] }); i += 1; j += 1 }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { out.push({ kind: 'del', text: a[i] }); i += 1 }
    else { out.push({ kind: 'add', text: b[j] }); j += 1 }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i] }); i += 1 }
  while (j < m) { out.push({ kind: 'add', text: b[j] }); j += 1 }
  return out
}

function buildDiff(beforeText, afterText) {
  const a = splitLines(beforeText)
  const b = splitLines(afterText)
  if (a.length > MAX_LINES_FOR_DIFF || b.length > MAX_LINES_FOR_DIFF) {
    return { tooLarge: true, additions: null, deletions: null, rows: [], rowsTruncated: false, hiddenRows: 0, minimal: false, ops: [] }
  }
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }

  const ops = []
  let oldNo = 1
  let newNo = 1
  for (let i = 0; i < start; i += 1) { ops.push({ kind: 'eq', oldNo: oldNo, newNo: newNo, text: a[i] }); oldNo += 1; newNo += 1 }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const minimal = midA.length <= MAX_LCS_SIDE && midB.length <= MAX_LCS_SIDE
  const mid = lcsOps(midA, midB)
  let additions = 0
  let deletions = 0
  for (const op of mid) {
    if (op.kind === 'eq') { ops.push({ kind: 'eq', oldNo: oldNo, newNo: newNo, text: op.text }); oldNo += 1; newNo += 1 }
    else if (op.kind === 'del') { ops.push({ kind: 'del', oldNo: oldNo, newNo: null, text: op.text }); oldNo += 1; deletions += 1 }
    else { ops.push({ kind: 'add', oldNo: null, newNo: newNo, text: op.text }); newNo += 1; additions += 1 }
  }
  for (let i = endA; i < a.length; i += 1) { ops.push({ kind: 'eq', oldNo: oldNo, newNo: newNo, text: a[i] }); oldNo += 1; newNo += 1 }

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
      if (hidden > 0) { rows.push({ kind: 'gap', oldNo: null, newNo: null, text: '', hidden: hidden }); hidden = 0 }
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
  return { tooLarge: false, additions: additions, deletions: deletions, rows: rows, rowsTruncated: rowsTruncated, hiddenRows: hiddenRows, minimal: minimal, ops: ops }
}

function officialCounts(before, after) {
  const parts = diffLines(before, after)
  let added = 0
  let removed = 0
  for (const part of parts) {
    const n = splitLines(part.value).length
    if (part.added) added += n
    else if (part.removed) removed += n
  }
  return { added, removed }
}

// ─────────── 断言 ───────────
let failures = 0
const kinds = new Map()
let printed = 0
function fail(kind, label, detail) {
  failures += 1
  const seen = (kinds.get(kind) || 0) + 1
  kinds.set(kind, seen)
  if (printed < 12) {
    printed += 1
    console.log(`FAIL [${kind}] ${label} :: ${detail}`)
  }
}

let cases = 0
let minimalCases = 0
let fallbackCases = 0

function check(label, before, after) {
  const mine = buildDiff(before, after)
  if (mine.tooLarge) return
  cases += 1
  const a = splitLines(before)
  const b = splitLines(after)

  // 1. 重建：从 ops 推回旧/新文本
  const rebuiltOld = []
  const rebuiltNew = []
  for (const op of mine.ops) {
    if (op.kind === 'eq') { rebuiltOld.push(op.text); rebuiltNew.push(op.text) }
    else if (op.kind === 'del') rebuiltOld.push(op.text)
    else rebuiltNew.push(op.text)
  }
  if (rebuiltOld.join('\u0000') !== a.join('\u0000')) fail('重建旧文本', label, `推回 ${rebuiltOld.length} 行 != 原文 ${a.length} 行`)
  if (rebuiltNew.join('\u0000') !== b.join('\u0000')) fail('重建新文本', label, `推回 ${rebuiltNew.length} 行 != 原文 ${b.length} 行`)

  // 2. 编辑脚本不变量
  const net = mine.additions - mine.deletions
  const delta = b.length - a.length
  if (net !== delta) fail('不变量', label, `净 ${net} != 行数差 ${delta}`)

  // 3. 折叠守恒
  if (!mine.rowsTruncated) {
    let hiddenSum = 0
    let shown = 0
    for (const row of mine.rows) {
      if (row.kind === 'gap') hiddenSum += row.hidden
      else shown += 1
    }
    if (hiddenSum + shown !== mine.ops.length) {
      fail('折叠守恒', label, `折叠 ${hiddenSum} + 可见 ${shown} != ops ${mine.ops.length}`)
    }
  }

  // 4. 行号自洽（在 ops 上断言：可见行因折叠本就不含尾部行号）
  let maxOld = 0
  let maxNew = 0
  for (const op of mine.ops) {
    if (typeof op.oldNo === 'number' && op.oldNo > maxOld) maxOld = op.oldNo
    if (typeof op.newNo === 'number' && op.newNo > maxNew) maxNew = op.newNo
  }
  if (maxOld !== a.length) fail('旧行号', label, `最大 ${maxOld} != 旧行数 ${a.length}`)
  if (maxNew !== b.length) fail('新行号', label, `最大 ${maxNew} != 新行数 ${b.length}`)

  // 5. 最小脚本规模对拍
  if (mine.minimal) {
    minimalCases += 1
    const official = officialCounts(before, after)
    const mineSize = mine.additions + mine.deletions
    const officialSize = official.added + official.removed
    if (mineSize !== officialSize) {
      fail('脚本规模', label, `本引擎 增${mine.additions}/删${mine.deletions}=${mineSize} vs diffLines 增${official.added}/删${official.removed}=${officialSize}`)
    } else if (official.added !== mine.additions) {
      // 规模相同但切分不同：最小脚本不唯一，属正常，仅记录
      kinds.set('切分不同(正常)', (kinds.get('切分不同(正常)') || 0) + 1)
    }
  } else {
    fallbackCases += 1
  }
}

// 具名边界用例
const named = [
  ['新建文件', '', 'a\nb\nc\n'],
  ['删除全部内容', 'a\nb\nc\n', ''],
  ['内容不变', 'a\nb\nc\n', 'a\nb\nc\n'],
  ['单行修改', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nC\nd\ne\nf\ng\n'],
  ['单行插入', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nNEW\nc\nd\ne\nf\ng\n'],
  ['单行删除', 'a\nb\nX\nc\nd\ne\nf\ng\n', 'a\nb\nc\nd\ne\nf\ng\n'],
  ['首行修改', 'a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n'],
  ['末行修改', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'],
  ['整体重写', 'a\nb\nc\nd\n', 'w\nx\ny\nz\n'],
  ['重复行干扰', 'x\nx\nx\nx\n', 'x\nx\n'],
  ['空行插入', 'a\nb\n', 'a\n\nb\n']
]
for (const [label, before, after] of named) check('named:' + label, before, after)

// 已知边界：文件末尾换行状态发生变化时，本引擎与 diff@9.0.0 的切分不同。
// 本引擎沿用 DSH 平台的行模型（单个末尾换行是终止符，不是多一行），
// 所以「给无尾换行的文件追加一行」记为 +1 −0；而 diffLines（以及 git，
// 它会打 \ No newline at end of file）记为 +2 −1。
// 两者净变化相同（+1），差异只在末行归属 —— 这是刻意保留的偏离，不是缺陷。
// 两侧行为都钉死：将来 diff 库若改变行为，这里会报警，提示重新评估该偏离。
{
  const mine = buildDiff('a\nb\nc', 'a\nb\nc\nd')
  const official = officialCounts('a\nb\nc', 'a\nb\nc\nd')
  console.log(`\n[边界] 无尾换行 + 追加一行 → 本引擎 +${mine.additions}/-${mine.deletions}；diffLines +${official.added}/-${official.removed}`)
  if (mine.additions !== 1 || mine.deletions !== 0) fail('边界', '无尾换行', `本引擎 +${mine.additions}/-${mine.deletions} != +1/-0`)
  if (official.added !== 2 || official.removed !== 1) fail('边界', '无尾换行', `diffLines +${official.added}/-${official.removed} != +2/-1（diff 库行为若变化，需重新评估此偏离）`)
  if (mine.additions - mine.deletions !== official.added - official.removed) fail('边界', '无尾换行', '两侧净变化不一致')
}

// 随机对拍
function rnd(n) { return Math.floor(Math.random() * n) }
const toText = (arr) => (arr.length === 0 ? '' : arr.join('\n') + '\n')
for (let i = 0; i < 4000; i += 1) {
  const n = 1 + rnd(60)
  const base = []
  for (let k = 0; k < n; k += 1) base.push('l' + k)
  const next = base.slice()
  const mutations = 1 + rnd(3)
  for (let t = 0; t < mutations; t += 1) {
    if (next.length === 0) break
    const at = rnd(next.length)
    const mode = rnd(3)
    if (mode === 0) next[at] = 'CHANGED' + t
    else if (mode === 1) next.splice(at, 0, 'INSERTED' + t)
    else next.splice(at, 1)
  }
  check('random#' + i, toText(base), toText(next))
}

// 大重写：故意超过 LCS 上限，走整段替换回退，只要求满足不变量与重建
{
  const big = []
  for (let k = 0; k < 1500; k += 1) big.push('old' + k)
  const big2 = []
  for (let k = 0; k < 1500; k += 1) big2.push('new' + k)
  check('override:1500x1500', toText(big), toText(big2))
}

// 真实屏幕数据回验：Cindy 截图里的 README.md 正是 +1 −0
{
  const before = Array.from({ length: 100 }, (_, i) => 'line' + i).join('\n') + '\n'
  const after = before + '以上第三方报道仅作参考，价格、生效时间、模型名一律以 DeepSeek 官方页面为准。\n'
  const mine = buildDiff(before, after)
  console.log(`\n[锚点] 100 行文件末尾追加 1 行 → 本引擎 +${mine.additions}/-${mine.deletions}（期望 +1/-0，与 Cindy 的 README.md 同形）`)
  if (mine.additions !== 1 || mine.deletions !== 0) fail('锚点', '追加一行', `+${mine.additions}/-${mine.deletions} != +1/-0`)
}

console.log(`\n用例总数：${cases}（最小脚本对拍 ${minimalCases}，整段替换回退 ${fallbackCases}）`)
if (kinds.size > 0) {
  for (const [kind, count] of kinds) console.log(`  ${kind}: ${count}`)
}
console.log(failures === 0 ? 'ALL PASS' : `FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
