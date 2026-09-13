// 预测一张「已改动」卡片会显示多少新增/删除 —— 用与宿主同一套逻辑（行级 diff +
// 前后缀裁剪 + LCS + 3 行上下文），所以卡片数字不对时可以用它对账。
//
// 运行： node verify/predict.mjs <编辑前文件> <编辑后文件>
// 换机器：对拍用的 diff 包取自 DSH 自带的 node_modules，装在别处就设 DSH_APP_DIR。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const require = createRequire(import.meta.url)
const DIFF_ROOT = join(
  process.env.DSH_APP_DIR !== undefined && process.env.DSH_APP_DIR !== ''
    ? process.env.DSH_APP_DIR
    : 'D:/DSH Desktop/resources/app',
  'node_modules',
  'diff'
)
let P
try { P = require(DIFF_ROOT) }
catch (e) { P = require(DIFF_ROOT + '/libcjs/index.cjs') }
const { diffLines } = P

const CTX = 3, LIM = 600, MAXL = 20000
function splitLines(t) {
  if (typeof t !== 'string' || t === '') return []
  const b = t.endsWith('\n') ? t.slice(0, -1) : t
  return b.split('\n')
}
function lcsOps(a, b) {
  const out = []
  if (a.length === 0) { for (const t of b) out.push({ k: 'add', t }); return out }
  if (b.length === 0) { for (const t of a) out.push({ k: 'del', t }); return out }
  if (a.length > LIM || b.length > LIM) {
    for (const t of a) out.push({ k: 'del', t })
    for (const t of b) out.push({ k: 'add', t })
    return out
  }
  const n = a.length, m = b.length, w = m + 1
  const tb = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    const r = i * w, nx = (i + 1) * w
    for (let j = m - 1; j >= 0; j--) {
      tb[r + j] = a[i] === b[j] ? tb[nx + j + 1] + 1 : (tb[nx + j] >= tb[r + j + 1] ? tb[nx + j] : tb[r + j + 1])
    }
  }
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ k: 'eq', t: a[i] }); i++; j++ }
    else if (tb[(i + 1) * w + j] >= tb[i * w + j + 1]) { out.push({ k: 'del', t: a[i] }); i++ }
    else { out.push({ k: 'add', t: b[j] }); j++ }
  }
  while (i < n) { out.push({ k: 'del', t: a[i] }); i++ }
  while (j < m) { out.push({ k: 'add', t: b[j] }); j++ }
  return out
}
function buildDiff(bt, at) {
  const a = splitLines(bt), b = splitLines(at)
  if (a.length > MAXL || b.length > MAXL) return { tooLarge: true, add: 0, del: 0, rows: [] }
  let s = 0
  while (s < a.length && s < b.length && a[s] === b[s]) s++
  let ea = a.length, eb = b.length
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const ops = []
  let on = 1, nn = 1
  for (let i = 0; i < s; i++) ops.push({ kind: 'eq', oldNo: on++, newNo: nn++, text: a[i] })
  const mid = lcsOps(a.slice(s, ea), b.slice(s, eb))
  let add = 0, del = 0
  for (const op of mid) {
    if (op.k === 'eq') ops.push({ kind: 'eq', oldNo: on++, newNo: nn++, text: op.t })
    else if (op.k === 'del') { ops.push({ kind: 'del', oldNo: on++, newNo: null, text: op.t }); del++ }
    else { ops.push({ kind: 'add', oldNo: null, newNo: nn++, text: op.t }); add++ }
  }
  for (let i = ea; i < a.length; i++) ops.push({ kind: 'eq', oldNo: on++, newNo: nn++, text: a[i] })
  const keep = new Array(ops.length).fill(false)
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === 'eq') continue
    const lo = Math.max(0, i - CTX), hi = Math.min(ops.length - 1, i + CTX)
    for (let j = lo; j <= hi; j++) keep[j] = true
  }
  const rows = []
  let hid = 0
  for (let i = 0; i < ops.length; i++) {
    if (keep[i]) { if (hid > 0) { rows.push({ kind: 'gap', hidden: hid }); hid = 0 } rows.push(ops[i]) }
    else hid++
  }
  if (hid > 0) rows.push({ kind: 'gap', hidden: hid })
  return { tooLarge: false, add, del, rows }
}

const before = readFileSync(process.argv[2], 'utf8')
const after = readFileSync(process.argv[3], 'utf8')
const d = buildDiff(before, after)
const bl = splitLines(before).length, al = splitLines(after).length
const off = diffLines(before, after)
let oa = 0, od = 0
for (const p of off) { const n = splitLines(p.value).length; if (p.added) oa += n; else if (p.removed) od += n }
console.log('before_lines=' + bl + ' after_lines=' + al + ' delta=' + (al - bl))
console.log('PLUGIN_EXPECT=+' + d.add + ' -' + d.del)
console.log('diffLines=+' + oa + ' -' + od)
console.log('mine_invariant=' + (d.add - d.del === al - bl) + ' official_invariant=' + (oa - od === al - bl))
const gaps = d.rows.filter(r => r.kind === 'gap')
console.log('rows=' + d.rows.length + ' gaps=' + gaps.length + ' hidden_total=' + gaps.reduce((s2, g) => s2 + g.hidden, 0))
console.log('---- render (unified) ----')
for (const r of d.rows) {
  if (r.kind === 'gap') { console.log('        ... ' + r.hidden + ' unchanged'); continue }
  const mark = r.kind === 'del' ? '-' : (r.kind === 'add' ? '+' : ' ')
  const o = r.oldNo === null || r.oldNo === undefined ? '' : String(r.oldNo)
  const n = r.newNo === null || r.newNo === undefined ? '' : String(r.newNo)
  console.log((o + '      ').slice(0, 6) + (n + '      ').slice(0, 6) + ' ' + mark + ' ' + r.text.slice(0, 78))
}
