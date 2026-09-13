// dsh-turn-changes 一次性安装脚本。
//
// 复用 DSH Desktop 自带的 generation 安装管线（dsh-desktop-market-installer），
// 所以装出来的形状与「从市场安装」逐字一致：写入一个 generation、更新 desired.json、
// 再把 generation 投影成 $DSH_HOME 下的 bundle + link。
//
// 用法：
//   node install.mjs [DSH 应用目录]
// DSH 应用目录也可以通过 DSH_APP_DIR 指定，默认 D:\DSH Desktop\resources\app。
//
// 装完需要重启 DSH（客户端 bundle 在启动时注入浏览器）。
// 卸载：把 $DSH_HOME/generations/desired.json 里这一代去掉，再重启。
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR =
  process.argv[2] !== undefined && process.argv[2] !== ''
    ? process.argv[2]
    : process.env.DSH_APP_DIR !== undefined && process.env.DSH_APP_DIR !== ''
      ? process.env.DSH_APP_DIR
      : 'D:/DSH Desktop/resources/app'

const DSH_HOME =
  process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(process.env.APPDATA === undefined ? process.cwd() : process.env.APPDATA, 'dsh-desktop', 'harness')

const INSTALLER_PKG = join(APP_DIR, 'node_modules', 'dsh-desktop-market-installer')
const NODE_EXE = join(APP_DIR, 'node_modules', 'node', 'bin', 'node.exe')
const PNPM_ENTRY = join(APP_DIR, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

const PLUGIN_SPEC = 'dsh-turn-changes'
const SOURCE_DIR = HERE
const SOURCE_SPEC = 'link:' + SOURCE_DIR

console.log('DSH_HOME      = ' + DSH_HOME)
console.log('DSH_APP_DIR   = ' + APP_DIR)
console.log('SOURCE_DIR    = ' + SOURCE_DIR)

let installer
let registry
let projection
try {
  installer = await import(pathToFileURL(join(INSTALLER_PKG, 'generations/installer.mjs')).href)
  registry = await import(pathToFileURL(join(INSTALLER_PKG, 'generations/registry.mjs')).href)
  projection = await import(pathToFileURL(join(INSTALLER_PKG, 'generations/projection.mjs')).href)
} catch (err) {
  console.error('找不到 DSH 的安装管线：' + INSTALLER_PKG)
  console.error('请把 DSH 应用目录作为参数传入，或设置 DSH_APP_DIR。')
  console.error(String(err))
  process.exit(1)
}

const generation = await registry.withRegistryLock(DSH_HOME, async () => {
  const install = await installer.installGeneration({
    dshHome: DSH_HOME,
    pluginSpec: PLUGIN_SPEC,
    sourceSpec: SOURCE_SPEC,
    sourceDirectory: SOURCE_DIR,
    nodeExecutablePath: NODE_EXE,
    pnpmEntryPath: PNPM_ENTRY,
    environment: {
      ...process.env,
      CI: 'true',
      NO_COLOR: '1',
      npm_config_side_effects_cache: 'false'
    },
    onTrace: (line) => console.log('[trace]', line),
    onOutput: (chunk) => process.stdout.write(chunk)
  })
  if (!install.ok) {
    console.error('安装失败：' + install.detail)
    process.exit(1)
  }
  console.log('installed generation: ' + JSON.stringify(install.generation))

  // 与桌面端市场安装同样的做法：同插件的旧代替换掉，其他代保留。
  const [desired, generations] = await Promise.all([
    registry.readDesired(DSH_HOME),
    registry.listGenerations(DSH_HOME)
  ])
  const byId = new Map(generations.map((item) => [item.id, item]))
  const kept = desired.filter((id) => {
    const gen = byId.get(id)
    return gen === undefined || gen.pluginName !== install.generation.pluginName
  })
  const next = [...kept, install.generation.id]
  await registry.writeDesired(DSH_HOME, next)
  console.log('desired.json now: ' + JSON.stringify(next))

  const result = await projection.projectGenerations(DSH_HOME)
  console.log('projection linked: ' + JSON.stringify(result.linked))
  console.log('projection bundles: ' + JSON.stringify(result.bundles))
  return install.generation
})

console.log('完成，generation id = ' + generation.id)
console.log('重启 DSH 后生效；验收步骤见 HANDOVER.md 的「装完怎么验收」。')
