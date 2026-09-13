// 行尾回归测试：在 CRLF 检出的仓库里，tools/port.mjs 也必须生成逐字节相同的 lib/。
//
// 背景（实测踩到过）：JS 规范规定模板字面量源码里的 <CR><LF> 在解析时被规范化成 <LF>，
// 而 readFileSync 读出来是原样字节。port.mjs 的锚点都写在模板字面量里，所以源码一旦是 CRLF，
// 带换行的锚点会全部失配（单行锚点却正常）—— Windows 上用默认 core.autocrlf=true 克隆下来
// 正好就是这个状态，表现为「原目录能生成、全新克隆里 10 个多行锚点全部命中 0 次」。
//
// 这个脚本把 dynamic/*.js 与 tools/port.mjs 复制成 CRLF，在那个沙箱里跑一遍生成器（直接
// import，不起子进程），再把生成结果与本仓库的 lib/ 逐字节比对。
// 若这里打印「移植失败」，那就是防行尾失配的代码坏了。
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'turn-changes-crlf-'))

function toCrlf(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
  writeFileSync(path, text)
  return text.split('\r\n').length - 1
}

mkdirSync(join(SANDBOX, 'tools'), { recursive: true })
mkdirSync(join(SANDBOX, 'lib'), { recursive: true })
cpSync(join(ROOT, 'dynamic'), join(SANDBOX, 'dynamic'), { recursive: true })
cpSync(join(ROOT, 'tools', 'port.mjs'), join(SANDBOX, 'tools', 'port.mjs'))

let crlfLines = 0
for (const name of ['host.js', 'client.js']) crlfLines += toCrlf(join(SANDBOX, 'dynamic', name))
crlfLines += toCrlf(join(SANDBOX, 'tools', 'port.mjs'))
console.log('沙箱已就绪：' + SANDBOX)
console.log('已把 dynamic/host.js、dynamic/client.js、tools/port.mjs 转成 CRLF（共 ' + crlfLines + ' 行）')

// 生成器按相对路径读写，所以直接切到沙箱里 import 它。
process.chdir(SANDBOX)
console.log('---- 在 CRLF 沙箱里运行生成器 ----')
await import(pathToFileURL(join(SANDBOX, 'tools', 'port.mjs')).href)
process.chdir(ROOT)

let failures = 0
for (const name of ['index.js', 'client.js']) {
  const generated = readFileSync(join(SANDBOX, 'lib', name), 'utf8')
  const committed = readFileSync(join(ROOT, 'lib', name), 'utf8')
  const same = generated === committed
  if (same !== true) failures += 1
  const crlf = generated.split('\r\n').length - 1
  console.log((same ? 'PASS  ' : 'FAIL  ') + 'lib/' + name + ' 与仓库一致（' + generated.length + ' 字节，其中 CRLF ' + crlf + ' 处）')
}

rmSync(SANDBOX, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? 'PASS  CRLF 检出的仓库也能生成一致的 lib/' : 'FAIL  ' + failures + ' 个文件不一致')
process.exit(failures === 0 ? 0 : 1)
