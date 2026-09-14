// dsh-turn-changes —— 会话内开发加载器（动态 Cordis 插件）的两半源码。
//
// 为什么需要它：动态插件包是进程内对象，DSH 一重启就没了。而每次改一行 UI 都要把几十 KB
// 源码重新提交一遍（`cordis_define` 的入参）也不现实。所以动态形态改成「加载器 + 仓库源码」：
//
//   1. 用本文件导出的两半源码定义一次动态插件（idPrefix 建议 `rsbld`）并激活；
//   2. 加载器从仓库按 dynamic/<half>/index.json 拼接部件，用 `new Function` 在对应半边执行；
//   3. 以后改代码只改仓库文件，然后「重启同一个包」（cordis_run mode:'run'）即可生效 ——
//      注册与副作用都挂在加载器那条 fiber 上，重启会先干净地销毁上一次的全部注册。
//
// 用法（把两段源码取出来交给 cordis_define 的 code.host / code.client）：
//   node -e "import('./tools/loader.mjs').then(m => { console.log(m.HOST); console.error('----'); console.log(m.CLIENT) })"
//
// 仓库是唯一源码：这个文件里的加载器本身是稳定外壳，正常情况下不需要改。

/** 仓库根（绝对路径；加载器跑在 DSH 进程里，工作目录不是仓库）。 */
export const REPO = 'D:/AI/DeepseekPlugin/dsh-turn-changes'

/** 宿主半：读部件 → 拼接 → 执行真正的宿主插件体。 */
export const HOST = `return {
  inject: ['timer'],
  apply(ctx) {
    const REPO = '${REPO}'

    function describe(err) {
      if (err === null || err === undefined) return String(err)
      if (typeof err.message === 'string') return err.message
      return String(err)
    }

    async function readRel(rel) {
      const fs = ctx.get('fs')
      if (fs === undefined || fs === null) throw new Error('fs 服务不可用')
      const target = await fs.resolve(REPO + '/' + rel)
      const text = await fs.readText(target)
      if (typeof text !== 'string') throw new Error('readText(' + rel + ') 返回 ' + typeof text)
      return text
    }

    // 与 tools/port.mjs 的 assemble 同一套拼接规则：每段去掉尾部空白 + 恰好一个换行后直接相接。
    async function assemble(half) {
      const indexText = await readRel('dynamic/' + half + '/index.json')
      const parts = JSON.parse(indexText)
      if (!Array.isArray(parts) || parts.length === 0) throw new Error('dynamic/' + half + '/index.json 不是非空数组')
      let source = ''
      for (const part of parts) {
        if (typeof part !== 'string') continue
        const text = await readRel('dynamic/' + half + '/' + part)
        source += text.replace(/\\s*$/, '') + '\\n'
      }
      return { parts: parts, source: source }
    }

    // 客户端半拿不到仓库源码，所以由宿主代读，经包内私有通道交给它。
    harness.handle('rsb/source', async (args) => {
      const half = args !== null && typeof args === 'object' && typeof args.half === 'string' ? args.half : 'client'
      const loaded = await assemble(half)
      return { half: half, parts: loaded.parts, length: loaded.source.length, text: loaded.source }
    })

    async function boot() {
      try {
        const loaded = await assemble('host')
        const factory = new Function('ctx', 'harness', 'console', loaded.source)
        const mod = factory(ctx, harness, console)
        if (mod === null || typeof mod !== 'object' || typeof mod.apply !== 'function') {
          throw new Error('宿主半没有返回 { apply }')
        }
        mod.apply(ctx)
        console.log('[rsb] host | ' + loaded.parts.join(' + ') + ' | ' + loaded.source.length + ' chars')
      } catch (err) {
        console.error('[rsb] host 加载失败 | ' + describe(err))
      }
    }
    boot()
  }
}`

/** 客户端半：向宿主半要源码文本 → 执行真正的客户端插件体。 */
export const CLIENT = `return {
  inject: ['timer'],
  async apply(ctx) {
    function describe(err) {
      if (err === null || err === undefined) return String(err)
      if (typeof err.message === 'string') return err.message
      return String(err)
    }

    // 加载失败时也要占用右栏槽：否则整列会退回出厂的工具详情面板，
    // 让人以为是「右侧栏没了」而不是「代码里有错」。
    function showLoadError(message) {
      const slots = ctx.get('slots')
      if (slots === undefined || slots === null) return
      try {
        slots.register({ name: 'details' }, function RsbLoadError() {
          return React.createElement('div', { className: 'rsb-load-error' }, '右侧栏客户端半加载失败：' + message)
        })
      } catch (err) { /* ignore */ }
    }

    try {
      const res = await host.call('rsb/source', { half: 'client' })
      if (res === null || typeof res !== 'object' || typeof res.text !== 'string') {
        throw new Error('宿主没有返回客户端源码文本')
      }
      const factory = new Function('ctx', 'React', 'host', 'styles', 'console', res.text)
      const mod = factory(ctx, React, host, styles, console)
      if (mod === null || typeof mod !== 'object' || typeof mod.apply !== 'function') {
        throw new Error('客户端半没有返回 { apply }')
      }
      mod.apply(ctx)
      console.log('[rsb] client | ' + String(res.parts) + ' | ' + res.text.length + ' chars')
    } catch (err) {
      const message = describe(err)
      console.error('[rsb] client 加载失败 | ' + message)
      showLoadError(message)
    }
  }
}`
