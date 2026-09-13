// 离线验证客户端半的两个算法，用的是插件真实落盘的 rows 数据：
//   1) 分栏配对（照搬 Cindy diffRows.ts:284-297 pairChangedLines）
//   2) 词级高亮（照搬 Cindy inlineDiff.ts + jsdiff diffWordsWithSpace 分词器）
// 下面 inlineDiffRanges / buildRenderRows 是从 lib/client.js 里逐字搬过来的，
// 只去掉了 React 部分。若改了两边不一致，验证就失效，所以两边必须同步修改。
//
// 运行： node verify/verify-pairing.mjs [会话状态 JSON]
// 不传路径时自动取 $DSH_HOME/turn-changes 下最大的 session-*.json。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const INLINE_MAX_LINE = 1000
const INLINE_MIN_COMMON_RATIO = 0.3
const INLINE_MAX_PAIR_COUNT = 150
const INLINE_MAX_TOTAL_CHARS = 200000
const INLINE_MAX_TOKEN_PRODUCT = 400000

const WORD_CHARS = 'a-zA-Z0-9_\\u00ad\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u02c6\\u02c8-\\u02d7\\u02de-\\u02ff\\u1e00-\\u1eff'
let tokenRe = null
function tokensOf(text) {
  if (tokenRe === null) {
    tokenRe = new RegExp('(\\r?\\n)|[' + WORD_CHARS + ']+|[^\\S\\n\\r]+|[^' + WORD_CHARS + ']', 'gu')
  }
  const matched = text.match(tokenRe)
  return matched === null ? [] : matched
}

function tokenOps(a, b) {
  const n = a.length
  const m = b.length
  const out = []
  if (n === 0) {
    for (const token of b) out.push({ kind: 'add', text: token })
    return out
  }
  if (m === 0) {
    for (const token of a) out.push({ kind: 'del', text: token })
    return out
  }
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

function mergeRanges(ranges, contentLength) {
  const normalized = []
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, contentLength))
    const end = Math.max(0, Math.min(range.end, contentLength))
    if (start < end) normalized.push({ start: start, end: end })
  }
  normalized.sort((left, right) => (left.start - right.start) || (left.end - right.end))
  const merged = []
  for (const range of normalized) {
    const previous = merged.length > 0 ? merged[merged.length - 1] : null
    if (previous !== null && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  }
  return merged
}

function inlineDiffRanges(oldText, newText) {
  if (oldText.length === 0 || newText.length === 0) return null
  if (oldText.length > INLINE_MAX_LINE || newText.length > INLINE_MAX_LINE) return null
  if (oldText === newText) return null
  const a = tokensOf(oldText)
  const b = tokensOf(newText)
  if (a.length * b.length > INLINE_MAX_TOKEN_PRODUCT) return null
  const ops = tokenOps(a, b)
  const deleteRanges = []
  const addRanges = []
  let oldOffset = 0
  let newOffset = 0
  let commonLength = 0
  for (const op of ops) {
    const length = op.text.length
    if (op.kind === 'del') {
      deleteRanges.push({ start: oldOffset, end: oldOffset + length })
      oldOffset += length
    } else if (op.kind === 'add') {
      addRanges.push({ start: newOffset, end: newOffset + length })
      newOffset += length
    } else {
      commonLength += length
      oldOffset += length
      newOffset += length
    }
  }
  const denominator = oldText.length > newText.length ? oldText.length : newText.length
  if (commonLength / denominator < INLINE_MIN_COMMON_RATIO) return null
  const mergedDelete = mergeRanges(deleteRanges, oldText.length)
  const mergedAdd = mergeRanges(addRanges, newText.length)
  if (mergedDelete.length === 0 && mergedAdd.length === 0) return null
  return { deleteRanges: mergedDelete, addRanges: mergedAdd }
}

function buildRenderRows(rows) {
  const rangesByRow = new Map()
  const runs = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row !== null && typeof row === 'object' && (row.kind === 'del' || row.kind === 'add')) {
      const deletes = []
      const adds = []
      while (i < rows.length && rows[i] !== null && typeof rows[i] === 'object' && (rows[i].kind === 'del' || rows[i].kind === 'add')) {
        if (rows[i].kind === 'del') deletes.push(rows[i])
        else adds.push(rows[i])
        i += 1
      }
      runs.push({ deletes: deletes, adds: adds })
      continue
    }
    i += 1
  }

  let pairCount = 0
  let totalChars = 0
  let skipInline = false
  for (const run of runs) {
    const count = Math.min(run.deletes.length, run.adds.length)
    for (let j = 0; j < count; j += 1) {
      pairCount += 1
      totalChars += run.deletes[j].text.length + run.adds[j].text.length
      if (pairCount > INLINE_MAX_PAIR_COUNT || totalChars > INLINE_MAX_TOTAL_CHARS) {
        skipInline = true
        break
      }
    }
    if (skipInline) break
  }
  if (!skipInline) {
    for (const run of runs) {
      const count = Math.min(run.deletes.length, run.adds.length)
      for (let j = 0; j < count; j += 1) {
        const deleteRow = run.deletes[j]
        const addRow = run.adds[j]
        const ranges = inlineDiffRanges(deleteRow.text, addRow.text)
        if (ranges === null) continue
        if (ranges.deleteRanges.length > 0) rangesByRow.set(deleteRow, ranges.deleteRanges)
        if (ranges.addRanges.length > 0) rangesByRow.set(addRow, ranges.addRanges)
      }
    }
  }

  const unified = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.kind === 'gap') {
      unified.push({ type: 'gap', count: row.hidden, key: 'ug' + unified.length })
      continue
    }
    if (row.kind === 'sep') {
      unified.push({ type: 'gap', count: 0, key: 'us' + unified.length })
      continue
    }
    const ranges = rangesByRow.get(row)
    unified.push({ type: 'line', row: row, ranges: ranges === undefined ? null : ranges, key: 'ul' + unified.length })
  }

  const split = []
  i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (row === null || typeof row !== 'object') { i += 1; continue }
    if (row.kind === 'gap') {
      split.push({ type: 'gap', count: row.hidden, key: 'sg' + split.length })
      i += 1
      continue
    }
    if (row.kind === 'sep') {
      split.push({ type: 'gap', count: 0, key: 'ss' + split.length })
      i += 1
      continue
    }
    if (row.kind === 'eq') {
      split.push({ type: 'line', left: row, right: row, leftRanges: null, rightRanges: null, key: 'sc' + split.length })
      i += 1
      continue
    }
    const deletes = []
    const adds = []
    while (i < rows.length && rows[i] !== null && typeof rows[i] === 'object' && (rows[i].kind === 'del' || rows[i].kind === 'add')) {
      if (rows[i].kind === 'del') deletes.push(rows[i])
      else adds.push(rows[i])
      i += 1
    }
    const count = Math.max(deletes.length, adds.length)
    for (let j = 0; j < count; j += 1) {
      const left = j < deletes.length ? deletes[j] : null
      const right = j < adds.length ? adds[j] : null
      const leftRanges = left === null ? null : rangesByRow.get(left)
      const rightRanges = right === null ? null : rangesByRow.get(right)
      split.push({
        type: 'line',
        left: left,
        right: right,
        leftRanges: leftRanges === undefined ? null : leftRanges,
        rightRanges: rightRanges === undefined ? null : rightRanges,
        key: 'sp' + split.length
      })
    }
  }

  return { unified: unified, split: split }
}

// ───────────────────────── 验证 ─────────────────────────

function resolveStatePath() {
  if (process.argv[2] !== undefined && process.argv[2] !== '') return process.argv[2]
  const root = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(process.env.APPDATA === undefined ? process.cwd() : process.env.APPDATA, 'dsh-desktop', 'harness')
  const dir = join(root, 'turn-changes')
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('session-') && name.endsWith('.json'))
  } catch (err) {
    names = []
  }
  if (names.length === 0) {
    console.error('没找到会话状态文件：' + dir)
    console.error('用法：node verify/verify-pairing.mjs <$DSH_HOME/turn-changes/session-*.json>')
    process.exit(1)
  }
  let best = names[0]
  for (const name of names) {
    if (statSync(join(dir, name)).size > statSync(join(dir, best)).size) best = name
  }
  console.log('读取状态文件：' + join(dir, best))
  return join(dir, best)
}
const state = JSON.parse(readFileSync(resolveStatePath(), 'utf8'))

let failures = 0
function check(label, ok, detail) {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : ' — ' + detail))
}

function mark(text, ranges, side) {
  if (ranges === null || ranges.length === 0) return text
  let out = ''
  let offset = 0
  for (const range of ranges) {
    out += text.slice(offset, range.start) + '[' + text.slice(range.start, range.end) + ']'
    offset = range.end
  }
  return out + text.slice(offset)
}

for (const changeSet of state.changeSets) {
  console.log('')
  console.log('=== turn ' + changeSet.turn + '  +' + changeSet.additions + ' -' + changeSet.deletions + ' ===')
  for (const file of changeSet.files) {
    const rows = Array.isArray(file.rows) ? file.rows : []
    const built = buildRenderRows(rows)
    const changed = rows.filter((r) => r.kind === 'del' || r.kind === 'add').length
    const gaps = rows.filter((r) => r.kind === 'gap').length
    const context = rows.filter((r) => r.kind === 'eq').length

    const splitLines = built.split.filter((r) => r.type === 'line').length
    const unifiedLines = built.unified.length

    console.log('  ' + file.path)
    console.log('    主机 rows=' + rows.length + '  改动行=' + changed + '  上下文=' + context + '  折叠=' + gaps)
    console.log('    统一视图渲染行=' + unifiedLines + '（应等于 rows 长度）')
    console.log('    分栏视图渲染行=' + splitLines)

    // 不变量 1：统一视图不丢行
    check('统一视图行数 == rows 行数', unifiedLines === rows.length, unifiedLines + ' vs ' + rows.length)

    // 不变量 2：分栏丢行与否——每个 del 恰好出现在左半栏一次，每个 add 恰好出现在右半栏一次
    const leftDels = built.split.filter((r) => r.type === 'line' && r.left !== null && r.left.kind === 'del').length
    const rightAdds = built.split.filter((r) => r.type === 'line' && r.right !== null && r.right.kind === 'add').length
    const wantDels = rows.filter((r) => r.kind === 'del').length
    const wantAdds = rows.filter((r) => r.kind === 'add').length
    check('分栏覆盖全部删除行', leftDels === wantDels, leftDels + ' vs ' + wantDels)
    check('分栏覆盖全部新增行', rightAdds === wantAdds, rightAdds + ' vs ' + wantAdds)

    // 不变量 3：上下文行左右相同
    const ctxBad = built.split.filter((r) => r.type === 'line' && r.left !== null && r.left.kind === 'eq' && r.left !== r.right).length
    check('上下文行左右同一行', ctxBad === 0, '异常 ' + ctxBad)

    // 不变量 4：配对是按下标来的——统计同处一行的 del+add 对数
    const paired = built.split.filter((r) => r.type === 'line' && r.left !== null && r.right !== null && r.left.kind === 'del' && r.right.kind === 'add')
    console.log('    同行成对的 删/增 = ' + paired.length + ' 对')

    // 不变量 5：词级区间合法（升序、不重叠、越界为 0）
    let rangeBad = 0
    let emphasised = 0
    for (const row of built.unified) {
      if (row.type !== 'line' || row.ranges === null) continue
      emphasised += 1
      const text = typeof row.row.text === 'string' ? row.row.text : ''
      let last = -1
      for (const range of row.ranges) {
        if (range.start < last || range.end <= range.start || range.end > text.length) rangeBad += 1
        last = range.end
      }
    }
    check('词级区间合法', rangeBad === 0, '异常区间 ' + rangeBad)
    console.log('    有词级高亮的行 = ' + emphasised + ' / ' + (wantDels + wantAdds))

    // 展示前几对真实配对与高亮
    let shown = 0
    for (const row of built.split) {
      if (row.type !== 'line') continue
      if (row.left === null || row.right === null) continue
      if (row.left.kind !== 'del' || row.right.kind !== 'add') continue
      if (shown >= 4) break
      shown += 1
      console.log('    ├ 旧 ' + row.left.oldNo + '  ' + mark(row.left.text, row.leftRanges, 'del'))
      console.log('    └ 新 ' + row.right.newNo + '  ' + mark(row.right.text, row.rightRanges, 'add'))
    }

    // 把真正拿到高亮的行全部列出来（[ ] 内就是会套 emphasis 背景的片段）
    console.log('    ﹝拿到词级高亮的行﹞')
    let found = 0
    for (const row of built.unified) {
      if (row.type !== 'line' || row.ranges === null) continue
      found += 1
      const kind = row.row.kind === 'add' ? '新' : '旧'
      const no = kind === '新' ? row.row.newNo : row.row.oldNo
      console.log('      ' + kind + ' ' + no + '  ' + mark(row.row.text, row.ranges, row.row.kind))
    }
    if (found === 0) console.log('      （无）')
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES')

// 合成用例：3删1增，验证 Cindy 的「新增配在第 1 行」
const synth = [
  { kind: 'eq', oldNo: 1, newNo: 1, text: 'keep' },
  { kind: 'del', oldNo: 2, newNo: null, text: 'const a = 1' },
  { kind: 'del', oldNo: 3, newNo: null, text: 'const b = 2' },
  { kind: 'del', oldNo: 4, newNo: null, text: 'const c = 3' },
  { kind: 'add', oldNo: null, newNo: 2, text: 'const a = 9' }
]
const synthBuilt = buildRenderRows(synth)
console.log('')
console.log('=== 合成用例 3删1增 ===')
for (const row of synthBuilt.split) {
  if (row.type === 'gap') { console.log('  gap'); continue }
  const l = row.left === null ? '——' : row.left.kind + ' ' + row.left.text
  const r = row.right === null ? '——' : row.right.kind + ' ' + row.right.text
  console.log('  左: ' + l.padEnd(22) + ' | 右: ' + r)
}
check('3删1增 分栏行数 = 4', synthBuilt.split.length === 4, String(synthBuilt.split.length))
check('新增配在第 1 行（索引 1）', synthBuilt.split[1].right !== null && synthBuilt.split[1].left !== null)
check('第 2、3 行右半栏为空', synthBuilt.split[2].right === null && synthBuilt.split[3].right === null)

// 合成用例：词级高亮，看 [ ] 标出的到底是哪几个字
console.log('')
console.log('=== 合成用例 词级高亮（[ ] = emphasis 底色） ===')
const cases = [
  ['改数字', 'const port = 3000', 'const port = 43129', true],
  ['改时间戳', '  "at": "2026-09-13T13:42:02.660Z",', '  "at": "2026-09-13T13:44:10.100Z",', true],
  ['换标识符', 'foo(bar, 1)', 'foo(baz, 1)', true],
  ['改方法名', 'await ctx.fs.writeText(target, text)', 'await ctx.fs.readText(target)', true],
  ['整行重写（公共比例过低）', 'const a = 1', 'totally different line here', false],
  ['旧行为空', '', 'brand new line', false]
]
for (const [label, before, after, expectRanges] of cases) {
  const ranges = inlineDiffRanges(before, after)
  const got = ranges !== null
  check(label, got === expectRanges, got ? '高亮' : '不highlight')
  if (ranges !== null) {
    console.log('      旧  ' + mark(before, ranges.deleteRanges, 'del'))
    console.log('      新  ' + mark(after, ranges.addRanges, 'add'))
  }
}

console.log('')
console.log(failures === 0 ? 'ALL PASS (含合成用例)' : failures + ' FAILURES')
