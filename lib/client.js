// dsh-turn-changes client half —— 静态浏览器 bundle。
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
        const layout = safeGet(ctx, 'layout')

    const MINUS = '\u2212'
    const VISIBLE_FILES = 5

    // ── 词级高亮的阈值，全部照搬 Cindy ──
    // refs/cindy/apps/desktop/src/renderer/.../DiffViewer/highlight.ts:3
    // refs/cindy/.../DiffViewer/inlineDiff.ts:24-28
    const INLINE_MAX_LINE = 1000
    const INLINE_MIN_COMMON_RATIO = 0.3
    const INLINE_MAX_PAIR_COUNT = 150
    const INLINE_MAX_TOTAL_CHARS = 200000
    // 自等效上限：token 数平方过大的行不做词级 diff，等价于 Cindy 的 timeout:20 放弃。
    const INLINE_MAX_TOKEN_PRODUCT = 400000

    let wideMode = true

    insertStyles(ctx, [
      '.tchg-root{margin:8px 0;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:12px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-1));box-shadow:0 1px 2px rgba(0,0,0,.04);overflow:hidden}',
      '.tchg-head{display:flex;align-items:center;gap:6px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta,0px))}',
      '.tchg-icon{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
      '.tchg-headcount{color:var(--dsw-alias-label-secondary)}',
      '.tchg-headstat{margin-left:auto;display:flex;align-items:center;gap:8px;font-family:var(--ds-font-family-code,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);font-variant-numeric:tabular-nums}',
      '.tchg-act{display:flex;align-items:center;gap:6px;margin-left:10px}',
      '.tchg-btn{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:6px;background:transparent;padding:1px 9px;cursor:pointer;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.tchg-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.tchg-btn:disabled{cursor:default;color:var(--dsw-alias-label-caption);border-color:var(--dsw-alias-border-l1)}',
      '.tchg-btn:disabled:hover{background:transparent}',
      '.tchg-warn{display:flex;gap:6px;padding:6px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px}',
      '.tchg-row{display:flex;align-items:center;width:100%;box-sizing:border-box;background:transparent}',
      '.tchg-row+.tchg-row{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.tchg-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.tchg-main{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:12px;padding:7px 4px 7px 14px;border:0;background:transparent;text-align:left;cursor:pointer;font:inherit;color:inherit}',
      '.tchg-ext{flex:0 0 auto;margin-right:8px;padding:2px 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));cursor:pointer;opacity:0;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:20px}',
      '.tchg-row:hover .tchg-ext,.tchg-ext:focus-visible{opacity:1}',
      '.tchg-ext:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.tchg-file{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:8px}',
      '.tchg-name{min-width:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta,0px));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tchg-row:hover .tchg-name{text-decoration:underline;text-underline-offset:2px}',
      '.tchg-dir{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.tchg-stat{flex:0 0 auto;display:flex;align-items:center;gap:8px;font-family:var(--ds-font-family-code,monospace);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;font-variant-numeric:tabular-nums}',
      '.tchg-add{color:var(--dsw-alias-state-success-primary)}',
      '.tchg-del{color:var(--dsw-alias-state-error-primary)}',
      '.tchg-note{padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px}',
      '.tchg-more{display:block;width:100%;box-sizing:border-box;padding:7px 14px;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;text-align:left;cursor:pointer;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.tchg-more:hover{background:var(--dsw-alias-interactive-bg-hover)}',

      // diff 语义色：直接照搬 Cindy 的设计 token 数值。
      // 出处 refs/cindy/packages/design-tokens/src/reference/color.json:6974-7279：
      //   diff-add-bg #F0FFF4 / diff-add-fg #22863A / diff-add-emphasis #ACF2BD
      //   diff-del-bg #FFEEF0 / diff-del-fg #B31D28 / diff-del-emphasis #FFD7D5
      //   dark: #033A16 / #7EE787 / rgba(46,160,67,.42) / #67060C / #FF7B72 / rgba(248,81,73,.42)
      // DSH 本身没有 diff 背景 token（DiffBlock.module.css:61-77 只设 color），
      // 所以这里自带一套，明暗用出厂机制 body[data-ds-dark-theme] 切换
      // （dsh-client-ui-theme/lib/index.js:46 的 toggleAttribute）。
      '.trv-root{--tchg-add-bg:#f0fff4;--tchg-add-fg:#22863a;--tchg-add-emph:#acf2bd;--tchg-del-bg:#ffeef0;--tchg-del-fg:#b31d28;--tchg-del-emph:#ffd7d5;--tchg-empty-bg:var(--dsw-alias-markdown-code-block);display:flex;flex-direction:column;height:100%;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      'body[data-ds-dark-theme] .trv-root{--tchg-add-bg:#033a16;--tchg-add-fg:#7ee787;--tchg-add-emph:rgba(46,160,67,.42);--tchg-del-bg:#67060c;--tchg-del-fg:#ff7b72;--tchg-del-emph:rgba(248,81,73,.42)}',
      // 加宽：:has() 已在本仓出厂 CSS 中使用（JsonTree.module.css:46、MarkdownText.module.css:54）。
      // 只有 frame 是 display:grid，其余祖先 div 上该声明无效，所以只会命中 frame。
      // --tchg-sb 由 JS 从 frame 行内样式读出侧边栏轨宽，不写死侧边栏。
      // data-details-collapsed 存在（右栏已关）时不生效，保证 ✕ 仍能关掉右栏。
      'div:has(.trv-root[data-wide="true"]):not([data-details-collapsed]){grid-template-columns:var(--tchg-sb,280px) minmax(0,1fr) clamp(440px,40vw,840px) !important}',
      '.trv-tabs{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}',
      '.trv-tab{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-bottom:0;border-radius:8px 8px 0 0;background:var(--dsw-alias-markdown-code-block);padding:3px 14px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.trv-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 14px 8px}',
      '.trv-title{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta,0px));font-weight:600}',
      '.trv-headstat{display:flex;align-items:center;gap:8px;font-family:var(--ds-font-family-code,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums}',
      '.trv-actions{margin-left:auto;display:flex;align-items:center;gap:6px}',
      '.trv-btn{border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:6px;background:transparent;padding:1px 9px;cursor:pointer;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.trv-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.trv-btn[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}',
      '.trv-banner{flex:0 0 auto;display:flex;gap:6px;margin:0 14px 8px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px}',
      '.trv-filesbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 14px;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px}',
      '.trv-scroll{flex:1 1 auto;overflow:auto}',
      '.trv-file+.trv-file{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}',
      '.trv-filehead{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:6px 14px;background:var(--dsw-alias-markdown-code-block);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.trv-file[data-focus=true] .trv-filehead{background:var(--dsw-alias-interactive-bg-hover)}',
      '.trv-fname{font-weight:600;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.trv-fpath{min-width:0;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.trv-fstat{margin-left:auto;flex:0 0 auto;display:flex;gap:8px;font-family:var(--ds-font-family-code,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums}',

      '.trv-body{padding:6px 0 10px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(19px + var(--dsh-content-font-delta,0px))}',
      '.trv-body[data-nonum=true] .trv-no{display:none}',
      // 统一视图：整行上色（含行号与符号格），与 Cindy 的 UnifiedLineRow 一致。
      // 故意不保留行悬停色：悬停会盖掉红/绿，Cindy 的 diff 行也没有悬停态。
      '.trv-row{display:flex;align-items:flex-start;min-height:calc(19px + var(--dsh-content-font-delta,0px));white-space:pre}',
      '.trv-row.trv-del{background:var(--tchg-del-bg)}',
      '.trv-row.trv-add{background:var(--tchg-add-bg)}',
      '.trv-no{flex:0 0 auto;width:38px;box-sizing:border-box;padding-right:8px;text-align:right;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));user-select:none;font-variant-numeric:tabular-nums}',
      '.trv-sign{flex:0 0 auto;width:13px;text-align:center;user-select:none;border-right:1px solid var(--dsw-alias-border-l1);margin-right:10px}',
      '.trv-text{flex:0 0 auto;padding-right:24px}',
      '.trv-eq{color:var(--dsw-alias-label-secondary)}',
      '.trv-del{color:var(--tchg-del-fg)}',
      '.trv-add{color:var(--tchg-add-fg)}',
      // 词级高亮：Cindy inlineDiff.ts:32-35 的 rounded-[2px] bg-[var(--diff-*-emphasis)]
      '.trv-emph-add{background:var(--tchg-add-emph);border-radius:2px}',
      '.trv-emph-del{background:var(--tchg-del-emph);border-radius:2px}',
      '.trv-gap{display:block;box-sizing:border-box;margin:3px 0;padding:1px 14px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-markdown-code-block);border-top:1px solid var(--dsw-alias-border-l1);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      // 分栏：Cindy 的 SplitLineRow（PlainUnifiedDiff.tsx:153-238）——grid-cols-2，
      // 每个半栏自带 [行号][符号][内容]，整半栏上色，空缺半栏用 surface 色。
      '.trv-splitrow{display:grid;grid-template-columns:1fr 1fr;white-space:pre}',
      '.trv-cell{display:flex;min-width:0;overflow:hidden;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.trv-cellnum{flex:0 0 auto;width:38px;box-sizing:border-box;padding-right:8px;text-align:right;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));user-select:none;font-variant-numeric:tabular-nums;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.trv-cellsign{flex:0 0 auto;width:13px;text-align:center;user-select:none}',
      '.trv-celltext{flex:1 1 auto;min-width:0;padding-right:12px;overflow:hidden}',
      '.trv-cell-add{background:var(--tchg-add-bg);color:var(--tchg-add-fg)}',
      '.trv-cell-del{background:var(--tchg-del-bg);color:var(--tchg-del-fg)}',
      '.trv-cell-eq{color:var(--dsw-alias-label-secondary)}',
      '.trv-cell-empty{background:var(--tchg-empty-bg)}',
      '.trv-note{padding:10px 14px;color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px}',
      '.trv-empty-state{padding:16px 14px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta,0px))}'
    ].join('\n'))

    // ── jsdiff diffWordsWithSpace 的分词器 ──
    // 出处 refs/../app/node_modules/diff/libesm/diff/word.js:23,274。
    // 我们 diff 的是单行文本（行内不含换行），所以 (\r?\n) 这个分支永远不会命中，
    // 实际就是「词 / 空白串 / 单标点」三类 token。
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

    // Cindy mergeInlineDiffRanges（inlineDiff.ts:98-120）：截断 → 丢弃空区间
    // → 按 start/end 排序 → start <= previous.end 就合并。
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

    // Cindy computeInlineDiffRanges（inlineDiff.ts:53-96）的逐条守卫与比例校验。
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

    // 把主机送来的统一行序重建为 Cindy 的两种渲染行：
    //  unified —— 原行序；在成对的删/增行上挂词级区间；
    //  split  —— 按 Cindy pairChangedLines（diffRows.ts:284-297）按下标配对，
    //            3删1增 时新增行配在第 1 行。
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

      // Cindy shouldSkipInlineDiffCollection（inlineDiff.ts:141-153）
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
            // Cindy collectInlineDiffRanges:127 只处理两侧都存在的配对
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
          // 上下文行两半相同（Cindy 的 context 行左右都是同一行）
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

    const rowCache = new Map()
    function renderRowsFor(cacheKey, rows) {
      const cached = rowCache.get(cacheKey)
      if (cached !== undefined) return cached
      const built = buildRenderRows(rows)
      if (rowCache.size >= 24) rowCache.clear()
      rowCache.set(cacheKey, built)
      return built
    }

    const changedTurns = new Map()
    let revision = 0
    let stopped = false
    let refreshEntry = null
    let registration = null
    let detailsRegistration = null

    let selected = null
    let scrolledFor = null
    const watchers = new Set()

    function notify() {
      for (const watcher of Array.from(watchers)) {
        try { watcher() } catch (err) { /* ignore */ }
      }
    }

    function selectMessage(next) {
      selected = next
      scrolledFor = null
      notify()
    }

    function syncFrame(el) {
      try {
        let node = el
        let hops = 0
        while (node !== null && node !== undefined && hops < 12) {
          const style = node.style
          if (style !== undefined && style !== null && typeof style.gridTemplateColumns === 'string' && style.gridTemplateColumns.length > 0) {
            const first = style.gridTemplateColumns.trim().split(/\s+/)[0]
            if (typeof first === 'string' && first.length > 0 && style.getPropertyValue('--tchg-sb') !== first) {
              style.setProperty('--tchg-sb', first)
            }
            return
          }
          node = node.parentElement
          hops += 1
        }
      } catch (err) { /* ignore */ }
    }

    function splitPath(path) {
      const normalized = path.replace(/\\/g, '/')
      const parts = normalized.split('/')
      const name = parts.length > 0 && parts[parts.length - 1] !== '' ? parts[parts.length - 1] : normalized
      const dirs = parts.slice(0, parts.length - 1)
      let dir = dirs.join('/')
      if (dirs.length > 3) dir = '\u2026/' + dirs.slice(dirs.length - 3).join('/')
      return { name: name, dir: dir }
    }

    function statNodes(additions, deletions, keyPrefix) {
      const out = []
      if (typeof additions === 'number' && additions > 0) {
        out.push(React.createElement('span', { className: 'tchg-add', key: keyPrefix + 'a' }, '+' + additions))
      }
      if (typeof deletions === 'number' && deletions > 0) {
        out.push(React.createElement('span', { className: 'tchg-del', key: keyPrefix + 'd' }, MINUS + deletions))
      }
      if (out.length === 0) out.push(React.createElement('span', { key: keyPrefix + 'z', className: 'tchg-add' }, '+0'))
      return out
    }

    function fileGlyph(key) {
      return React.createElement('svg', { key: key, className: 'tchg-icon', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none' },
        React.createElement('path', { d: 'M4 1.8h4.6L12.4 5.6v8.6H4z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        React.createElement('path', { d: 'M8.4 1.8v4h4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' })
      )
    }

    function openPanel(sessionId, turn, focusPath, openFile) {
      if (typeof sessionId !== 'string' || typeof turn !== 'number') {
        if (typeof openFile === 'function' && typeof focusPath === 'string') openFile(focusPath)
        return
      }
      selectMessage({ sessionId: sessionId, turn: turn, focusPath: typeof focusPath === 'string' ? focusPath : null })
      if (layout !== null && layout !== undefined && typeof layout.openDetails === 'function') layout.openDetails()
      else if (typeof openFile === 'function' && typeof focusPath === 'string') openFile(focusPath)
    }

    function prefixOf(kind) {
      if (kind === 'add') return '+'
      if (kind === 'del') return '-'
      return ' '
    }

    function lineNumbers(row) {
      const oldNo = row.oldNo === null || row.oldNo === undefined ? '' : String(row.oldNo)
      const newNo = row.newNo === null || row.newNo === undefined ? '' : String(row.newNo)
      return { oldNo: oldNo, newNo: newNo }
    }

    // 把一行文本按区间切成「普通文本 + 高亮 span」，与 Cindy
    // renderPlainInlineDiffHtml（inlineDiff.ts:230-258）同形。
    function contentNodes(text, ranges, side, keyPrefix) {
      if (ranges === null || ranges === undefined || ranges.length === 0) return text
      const out = []
      let offset = 0
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index]
        if (range.start > offset) out.push(text.slice(offset, range.start))
        out.push(React.createElement('span', {
          className: side === 'add' ? 'trv-emph-add' : 'trv-emph-del',
          key: keyPrefix + index
        }, text.slice(range.start, range.end)))
        offset = range.end
      }
      if (offset < text.length) out.push(text.slice(offset))
      return out
    }

    function gapNode(row) {
      const label = row.count > 0 ? '\u22ef ' + row.count + ' \u884c\u672a\u6539\u52a8' : '\u22ef'
      return React.createElement('div', { className: 'trv-gap', key: row.key }, label)
    }

    function unifiedNode(row) {
      const line = row.row
      const numbers = lineNumbers(line)
      const kind = line.kind
      const cls = kind === 'del' ? 'trv-del' : (kind === 'add' ? 'trv-add' : 'trv-eq')
      const ranges = row.ranges
      return React.createElement('div', { className: 'trv-row ' + cls, key: row.key },
        React.createElement('span', { className: 'trv-no', key: 'on' }, numbers.oldNo),
        React.createElement('span', { className: 'trv-no', key: 'nn' }, numbers.newNo),
        React.createElement('span', { className: 'trv-sign', key: 'sg' }, prefixOf(kind)),
        React.createElement('span', { className: 'trv-text', key: 'tx' },
          contentNodes(typeof line.text === 'string' ? line.text : '', ranges, kind === 'add' ? 'add' : 'del', row.key + '-'))
      )
    }

    function splitCellNode(cell, ranges, side, key) {
      if (cell === null) {
        return React.createElement('div', { className: 'trv-cell trv-cell-empty', key: key },
          React.createElement('span', { className: 'trv-cellnum', key: 'n' }),
          React.createElement('span', { className: 'trv-cellsign', key: 's' }),
          React.createElement('span', { className: 'trv-celltext', key: 't' })
        )
      }
      const kind = cell.kind
      const cls = kind === 'del' ? 'trv-cell-del' : (kind === 'add' ? 'trv-cell-add' : 'trv-cell-eq')
      const text = typeof cell.text === 'string' ? cell.text : ''
      return React.createElement('div', { className: 'trv-cell ' + cls, key: key },
        React.createElement('span', { className: 'trv-cellnum', key: 'n' }, side === 'left' ? lineNumbers(cell).oldNo : lineNumbers(cell).newNo),
        React.createElement('span', { className: 'trv-cellsign', key: 's' }, prefixOf(kind)),
        React.createElement('span', { className: 'trv-celltext', key: 't' },
          contentNodes(text, ranges, side === 'right' ? 'add' : 'del', key + '-'))
      )
    }

    function splitNode(row) {
      return React.createElement('div', { className: 'trv-splitrow', key: row.key },
        splitCellNode(row.left, row.leftRanges, 'left', 'l'),
        splitCellNode(row.right, row.rightRanges, 'right', 'r')
      )
    }

    function ReviewPanel(props) {
      const source = props === null || props === undefined ? {} : props
      const sessionId = source.sessionId
      const tickState = React.useState(0)
      const setTick = tickState[1]
      const dataState = React.useState(null)
      const data = dataState[0]
      const setData = dataState[1]
      const splitState = React.useState(false)
      const split = splitState[0]
      const setSplit = splitState[1]
      const foldState = React.useState(false)
      const folded = foldState[0]
      const setFolded = foldState[1]
      const wideState = React.useState(wideMode)
      const wide = wideState[0]
      const setWide = wideState[1]

      React.useEffect(() => {
        const watcher = () => setTick((value) => value + 1)
        watchers.add(watcher)
        return () => { watchers.delete(watcher) }
      }, [])

      const current = selected !== null && selected.sessionId === sessionId ? selected : null
      const turn = current === null ? null : current.turn
      const focusPath = current === null ? null : current.focusPath

      React.useEffect(() => {
        let alive = true
        setData(null)
        if (typeof turn !== 'number' || typeof sessionId !== 'string') return undefined
        apiCall('turn-changes/review', { sessionId: sessionId, turn: turn }).then((result) => {
          if (!alive) return
          setData(result !== null && result !== undefined && typeof result === 'object' && result.found === true ? result : null)
        }).catch((err) => {
          if (alive) setData(null)
        })
        return () => { alive = false }
      }, [sessionId, turn])

      const rootProps = {
        className: 'trv-root',
        'data-wide': wide ? 'true' : 'false',
        ref: (el) => { if (el !== null) syncFrame(el) }
      }

      if (current === null) {
        return React.createElement('div', rootProps,
          React.createElement('div', { className: 'trv-empty-state', key: 'e' }, '\u5728\u4e0b\u65b9\u300c\u5df2\u6539\u52a8\u300d\u5361\u7247\u4e0a\u70b9\u300c\u5ba1\u67e5\u300d\uff0c\u6216\u70b9\u67d0\u4e2a\u6587\u4ef6\u540d\uff0c\u8fd9\u91cc\u5217\u51fa\u8be5\u6761\u6d88\u606f\u7684\u5168\u90e8\u6539\u52a8\u3002'))
      }

      const children = []
      children.push(React.createElement('div', { className: 'trv-tabs', key: 'tabs' },
        React.createElement('div', { className: 'trv-tab', key: 'tab' }, '\u5ba1\u67e5')
      ))

      if (data === null) {
        children.push(React.createElement('div', { className: 'trv-note', key: 'load' }, '\u8bfb\u53d6\u4e2d\u2026'))
        return React.createElement('div', rootProps, children)
      }

      const files = Array.isArray(data.files) ? data.files : []
      children.push(React.createElement('div', { className: 'trv-head', key: 'head' },
        React.createElement('span', { className: 'trv-title', key: 't' }, '\u672c\u6761\u6d88\u606f\u7684\u53d8\u66f4'),
        React.createElement('span', { className: 'trv-headstat', key: 's' }, statNodes(data.additions, data.deletions, 'h')),
        React.createElement('span', { className: 'trv-actions', key: 'a' },
          React.createElement('button', { key: 'u', type: 'button', className: 'trv-btn', 'data-active': split ? 'false' : 'true', onClick: () => setSplit(false) }, '\u7edf\u4e00'),
          React.createElement('button', { key: 'p', type: 'button', className: 'trv-btn', 'data-active': split ? 'true' : 'false', onClick: () => setSplit(true) }, '\u5206\u680f'),
          React.createElement('button', { key: 'f', type: 'button', className: 'trv-btn', onClick: () => setFolded(!folded) }, folded ? '\u5c55\u5f00' : '\u6298\u53e0'),
          React.createElement('button', {
            key: 'w',
            type: 'button',
            className: 'trv-btn',
            'data-active': wide ? 'true' : 'false',
            title: wide ? '\u6062\u590d\u4e3a\u5e73\u53f0\u9ed8\u8ba4\u5bbd\u5ea6\uff08\u53ef\u62d6\u52a8\uff09' : '\u52a0\u5bbd\u9762\u677f\uff1b\u52a0\u5bbd\u671f\u95f4\u62d6\u52a8\u5206\u9694\u6761\u4e0d\u751f\u6548',
            onClick: () => {
              const next = !wide
              wideMode = next
              setWide(next)
            }
          }, wide ? '\u8fd8\u539f' : '\u52a0\u5bbd'),
          React.createElement('button', { key: 'c', type: 'button', className: 'trv-btn', title: '\u5173\u95ed', onClick: () => { if (layout !== null && layout !== undefined) layout.closeDetails() } }, '\u2715')
        )
      ))

      if (data.untracked === true) {
        children.push(React.createElement('div', { className: 'trv-banner', key: 'warn' },
          React.createElement('span', { key: 'i' }, '\u26a0'),
          React.createElement('span', { key: 'x' }, '\u672c\u6761\u6d88\u606f\u5305\u542b\u65e0\u6cd5\u7cbe\u786e\u8ffd\u8e2a\u7684\u547d\u4ee4\u6216\u5de5\u5177\u5199\u5165\uff1b\u4ee5\u4e0b\u4ec5\u5c55\u793a\u5df2\u7cbe\u786e\u6355\u83b7\u7684\u90e8\u5206\uff0c\u4e0d\u80fd\u89c6\u4e3a\u5b8c\u6574\u8865\u4e01\u3002')
        ))
      }

      children.push(React.createElement('div', { className: 'trv-filesbar', key: 'bar' }, files.length + ' \u4e2a\u6587\u4ef6'))

      if (files.length === 0) {
        children.push(React.createElement('div', { className: 'trv-empty-state', key: 'none' }, '\u8fd9\u6761\u6d88\u606f\u6ca1\u6709\u5df2\u7cbe\u786e\u6355\u83b7\u7684\u6539\u52a8\u3002'))
        return React.createElement('div', rootProps, children)
      }

      const scroll = []
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const path = typeof file.path === 'string' ? file.path : ''
        const parts = splitPath(path)
        const isFocus = focusPath !== null && focusPath === path
        const noNumbers = file.noNumbers === true
        const section = []
        section.push(React.createElement('div', { className: 'trv-filehead', key: 'fh' },
          React.createElement('span', { className: 'trv-fname', key: 'n' }, parts.name),
          parts.dir !== '' ? React.createElement('span', { className: 'trv-fpath', key: 'p' }, parts.dir) : null,
          React.createElement('span', { className: 'trv-fstat', key: 's' }, statNodes(file.additions, file.deletions, 'f'))
        ))
        const body = []
        if (file.tooLarge === true) {
          body.push(React.createElement('div', { className: 'trv-note', key: 'tl' }, '\u6587\u4ef6\u8fc7\u5927\uff0c\u672a\u751f\u6210\u884c\u7ea7 diff\u3002'))
        } else if (file.noRows === true) {
          body.push(React.createElement('div', { className: 'trv-note', key: 'nr' }, '\u8be5\u6587\u4ef6\u6ca1\u6709\u884c\u7ea7 diff\uff08\u4ec5\u6709\u8ba1\u6570\uff09\u3002'))
        } else if (folded) {
          body.push(React.createElement('div', { className: 'trv-note', key: 'fd' }, '\u5df2\u6298\u53e0'))
        } else {
          const rows = Array.isArray(file.rows) ? file.rows : []
          const built = renderRowsFor(String(sessionId) + '|' + String(turn) + '|' + path, rows)
          const useSplit = split && !noNumbers
          const list = useSplit ? built.split : built.unified
          for (const row of list) {
            if (row.type === 'gap') body.push(gapNode(row))
            else if (useSplit) body.push(splitNode(row))
            else body.push(unifiedNode(row))
          }
          if (file.rowsTruncated === true) {
            body.push(React.createElement('div', { className: 'trv-note', key: 'tr' }, '\u8fd8\u6709 ' + file.hiddenRows + ' \u884c\u672a\u5c55\u793a\uff08\u8d85\u51fa\u5355\u6b21\u4e0a\u9650\uff09\uff0c\u4e0a\u65b9\u8ba1\u6570\u4ecd\u4e3a\u5b8c\u6574\u503c\u3002'))
          }
        }
        section.push(React.createElement('div', { className: 'trv-body', key: 'b', 'data-nonum': noNumbers ? 'true' : 'false' }, body))
        scroll.push(React.createElement('div', {
          className: 'trv-file',
          key: 'file-' + index,
          'data-focus': isFocus ? 'true' : 'false',
          ref: (el) => {
            if (el === null) return
            if (!isFocus) return
            if (scrolledFor === focusPath) return
            scrolledFor = focusPath
            try { el.scrollIntoView({ block: 'start' }) } catch (err) { /* ignore */ }
          }
        }, section))
      }
      children.push(React.createElement('div', { className: 'trv-scroll', key: 'scroll' }, scroll))

      if (data.partial === true) {
        children.push(React.createElement('div', { className: 'trv-note', key: 'pt' }, '\u90e8\u5206\u6587\u4ef6\u8fc7\u5927\uff0c\u603b\u8ba1\u4ec5\u5305\u542b\u5df2\u8ba1\u7b97\u7684\u90e8\u5206\u3002'))
      }

      return React.createElement('div', rootProps, children)
    }

    function ChangedCard(props) {
      const source = props === null || props === undefined ? {} : props
      const matched = source.matched
      const sessionId = source.sessionId
      const openFile = source.openFile
      const turn = matched !== null && matched !== undefined && typeof matched === 'object' ? matched.turn : null
      const dataState = React.useState(null)
      const data = dataState[0]
      const setData = dataState[1]
      const expandState = React.useState(false)
      const expanded = expandState[0]
      const setExpanded = expandState[1]

      React.useEffect(() => {
        let alive = true
        if (typeof turn !== 'number' || typeof sessionId !== 'string') {
          setData(null)
          return undefined
        }
        apiCall('turn-changes/get', { sessionId: sessionId, turn: turn }).then((result) => {
          if (!alive) return
          setData(result !== null && result !== undefined && typeof result === 'object' && result.found === true ? result : null)
        }).catch((err) => {
          if (alive) setData(null)
        })
        return () => { alive = false }
      }, [sessionId, turn])

      if (data === null) return null
      const files = Array.isArray(data.files) ? data.files : []
      if (files.length === 0) return null

      const children = []
      children.push(React.createElement('div', { className: 'tchg-head', key: 'head' },
        fileGlyph('ic'),
        React.createElement('span', { className: 'tchg-headcount', key: 'c' }, '\u5df2\u6539\u52a8 ' + files.length + ' \u4e2a\u6587\u4ef6'),
        React.createElement('span', { className: 'tchg-headstat', key: 's' }, statNodes(data.additions, data.deletions, 'h')),
        React.createElement('span', { className: 'tchg-act', key: 'a' },
          React.createElement('button', { key: 'u', type: 'button', className: 'tchg-btn', disabled: true, title: '\u64a4\u9500\u4f1a\u771f\u5b9e\u6539\u5199\u5de5\u4f5c\u533a\u6587\u4ef6\uff0c\u672c\u7248\u4e0d\u505a' }, '\u21ba \u64a4\u9500'),
          React.createElement('button', { key: 'r', type: 'button', className: 'tchg-btn', onClick: () => openPanel(sessionId, turn, null, openFile) }, '\u5ba1\u67e5')
        )
      ))

      if (data.untracked === true) {
        children.push(React.createElement('div', { className: 'tchg-warn', key: 'w' },
          React.createElement('span', { key: 'i' }, '\u26a0'),
          React.createElement('span', { key: 'x' }, '\u4ec5\u7edf\u8ba1\u5df2\u7cbe\u786e\u6355\u83b7\u7684\u6539\u52a8\uff1b\u672c\u8f6e\u8fd8\u6709\u5176\u4ed6\u5de5\u5177\u5199\u5165\uff0c\u672a\u8ba1\u5165\u6b64\u5361\u7247\u3002')
        ))
      }

      const shown = expanded ? files : files.slice(0, VISIBLE_FILES)
      for (let index = 0; index < shown.length; index += 1) {
        const file = shown[index]
        const path = typeof file.path === 'string' ? file.path : ''
        const parts = splitPath(path)
        const rowChildren = [React.createElement('button', {
          key: 'main',
          type: 'button',
          className: 'tchg-main',
          title: '\u5728\u53f3\u4fa7\u680f\u5ba1\u67e5\u8be5\u6587\u4ef6\u7684\u6539\u52a8',
          onClick: () => openPanel(sessionId, turn, path, openFile)
        },
          React.createElement('span', { className: 'tchg-file', key: 'f' },
            React.createElement('span', { className: 'tchg-name', key: 'n' }, parts.name),
            parts.dir !== '' ? React.createElement('span', { className: 'tchg-dir', key: 'd' }, parts.dir) : null
          ),
          React.createElement('span', { className: 'tchg-stat', key: 's' }, statNodes(file.additions, file.deletions, 'r'))
        )]
        if (typeof openFile === 'function') {
          rowChildren.push(React.createElement('button', {
            key: 'ext',
            type: 'button',
            className: 'tchg-ext',
            title: '\u7528\u7cfb\u7edf\u9ed8\u8ba4\u7a0b\u5e8f\u6253\u5f00',
            onClick: () => openFile(path)
          }, '\u2197'))
        }
        children.push(React.createElement('div', { key: 'row-' + index, className: 'tchg-row' }, rowChildren))
      }

      if (files.length > VISIBLE_FILES) {
        children.push(React.createElement('button', {
          key: 'toggle',
          type: 'button',
          className: 'tchg-more',
          onClick: () => setExpanded(!expanded)
        }, expanded ? '\u6536\u8d77' : '\u518d\u663e\u793a ' + (files.length - VISIBLE_FILES) + ' \u4e2a\u6587\u4ef6'))
      }

      if (data.partial === true) {
        children.push(React.createElement('div', { className: 'tchg-note', key: 'pt' }, '\u90e8\u5206\u6587\u4ef6\u8fc7\u5927\uff0c\u603b\u8ba1\u4ec5\u5305\u542b\u5df2\u8ba1\u7b97\u7684\u90e8\u5206\u3002'))
      }

      return React.createElement('div', { className: 'tchg-root' }, children)
    }

    function mount() {
      if (registration !== null) {
        try { registration() } catch (err) { /* ignore */ }
        registration = null
      }
      registration = slots.register({
        name: 'conversation.chat.turnTail',
        select: selectClaim,
        priority: -1
      }, ChangedCard)
    }

    function absorb(entries) {
      if (!Array.isArray(entries)) return false
      let changed = false
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        const turn = entry.turn
        const sessionId = entry.sessionId
        if (typeof turn !== 'number' || typeof sessionId !== 'string') continue
        let sessions = changedTurns.get(turn)
        if (sessions === undefined) {
          sessions = []
          changedTurns.set(turn, sessions)
        }
        if (sessions.indexOf(sessionId) === -1) {
          sessions.push(sessionId)
          changed = true
        }
      }
      return changed
    }

    function selectClaim(owner) {
      if (owner === null || typeof owner !== 'object') return null
      const turn = owner.turn
      if (turn === null || typeof turn !== 'object') return null
      const number = turn.turn
      if (typeof number !== 'number') return null
      const sessions = changedTurns.get(number)
      if (sessions === undefined || sessions.length === 0) return null
      return { turn: number }
    }

    ctx.effect(() => slots.inject('conversation.chat.turnTail', () => {
      mount()
      refreshEntry = mount
      return () => {
        refreshEntry = null
        if (registration !== null) {
          try { registration() } catch (err) { /* ignore */ }
          registration = null
        }
      }
    }))

    // 占用右侧栏（details 槽）。该槽是 single，运行时会给动态注册的条目分配一个比出厂
    // 条目更低的秩（dsh-cordis-client-runner/lib/client.js:266-271），所以 priority
    // 参数其实会被丢弃；遮蔽由框架保证。
    ctx.effect(() => slots.inject('details', () => {
      if (detailsRegistration === null) {
        detailsRegistration = slots.register({ name: 'details' }, ReviewPanel)
      }
      return () => {
        if (detailsRegistration !== null) {
          try { detailsRegistration() } catch (err) { /* ignore */ }
          detailsRegistration = null
        }
      }
    }))

    // Host 启动时会把落盘的历史变更集随第一次轮询一起送来，所以这里不需要单独的索引调用。
    async function pump() {
      while (!stopped) {
        let result = null
        try {
          result = await apiCall('turn-changes/poll', { since: revision })
        } catch (err) {
          result = null
        }
        if (stopped) return
        if (result !== null && result !== undefined && typeof result === 'object') {
          if (typeof result.revision === 'number') revision = result.revision
          if (absorb(result.entries) && refreshEntry !== null) refreshEntry()
          if (result.closed === true) return
        }
        // 静态版的 poll 立即返回，所以每轮都要显式等一拍，否则会打成热循环。
        await sleep(POLL_INTERVAL_MS)
      }
    }
    pump()

        ctx.effect(() => () => { stopped = true })
      }
    }
  }
})

