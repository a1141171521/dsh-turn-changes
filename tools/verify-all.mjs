// 一次跑完所有离线验证，并汇总退出码。
//   node tools/verify-all.mjs
//
// 覆盖：
//   verify/verify-static-host.mjs  静态宿主半端到端（假 ctx 驱动：事件 → diff → 落盘 → HTTP）
//   verify/verify-line-diff.mjs    行级 diff 引擎对拍平台 diff@9.0.0（4000+ 用例）
//   verify/verify-pairing.mjs      分栏配对与词级高亮（读真实落盘 rows）
//   verify/predict.mjs             卡片计数预测器（自检一遍）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

function stateFile() {
  const root =
    process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(process.env.APPDATA === undefined ? process.cwd() : process.env.APPDATA, 'dsh-desktop', 'harness')
  const dir = join(root, 'turn-changes')
  if (!existsSync(dir)) return null
  const names = readdirSync(dir).filter((name) => name.startsWith('session-') && name.endsWith('.json'))
  if (names.length === 0) return null
  return join(dir, names[0])
}

const runs = []
runs.push({ label: 'verify-static-host', args: [join(ROOT, 'verify', 'verify-static-host.mjs')] })
runs.push({ label: 'verify-line-diff', args: [join(ROOT, 'verify', 'verify-line-diff.mjs')] })

const state = stateFile()
if (state === null) {
  console.log('SKIP  verify-pairing — 没找到 $DSH_HOME/turn-changes/session-*.json')
  console.log('      （先在 DSH 里跑一个会改文件的回合，状态文件才会出现；或手动传路径）')
} else {
  runs.push({ label: 'verify-pairing', args: [join(ROOT, 'verify', 'verify-pairing.mjs'), state] })
}

// predict 需要一对前后文本：自己造一个最小用例，验证它算得对（追加一行 → +1 −0）。
const scratch = mkdtempSync(join(tmpdir(), 'turn-changes-predict-'))
const beforePath = join(scratch, 'before.txt')
const afterPath = join(scratch, 'after.txt')
writeFileSync(beforePath, 'a\nb\n')
writeFileSync(afterPath, 'a\nb\nc\n')
runs.push({ label: 'predict', args: [join(ROOT, 'verify', 'predict.mjs'), beforePath, afterPath] })

let failures = 0
for (const run of runs) {
  console.log('')
  console.log('════════ ' + run.label + ' ════════')
  const result = spawnSync(process.execPath, run.args, { stdio: 'inherit', env: process.env })
  const code = result.status === null ? 1 : result.status
  if (code !== 0) failures += 1
  console.log('→ ' + run.label + ' 退出码 ' + code)
}

rmSync(scratch, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '全部通过（' + runs.length + ' 项）' : failures + ' 项失败')
process.exit(failures === 0 ? 0 : 1)
