    // ═══════════════════ 右侧栏（Cindy RightSidebarShell 的 DSH 落地） ═══════════════════
    //
    // DSH 的右栏是 details 槽：single + session 作用域，一列只能有一个占用者，谁占谁就是整列。
    // 所以「像 Cindy 那样多页签的右侧栏」只能在列内自己实现：一条 36px 页签栏 + 若干页签体。
    // 结构照搬 Cindy 的三条：页签体全部挂载、只靠 CSS 切可见性（切页签不重挂载，保住滚动位置）；
    // 每个页签外套一层错误边界（Cindy TabBodyErrorBoundary.tsx:22-86），一个页签崩了不带走整列；
    // 页签表就是清单（Cindy 的内置页签表 RSB/tabRegistry.ts）。
    //
    // 以后要接的能力（文件浏览器 / 工具详情 / 终端 / 子代理 / 后台任务 / 内置浏览器）
    // 只需要往 SIDEBAR_TABS 里加一行 + 写一个 Body 组件。

    const SIDEBAR_TABS = [
      { id: 'review', label: '审查', hint: '本条的变更（行级 diff）', order: 15, Body: ReviewBody }
    ]

    // 面板可见性。布局服务只有 openDetails / closeDetails / toggleSidebar，没有「当前开着吗」
    // 的读取口（client Service 契约实测），所以状态自己维护：量自己那棵子树的实际宽度
    // —— 收起时布局把列宽压成 0（06 报告 10.1 实测）。量到 0 就认为关了。
    const sidebarState = {
      width: 0,
      view: 'review',
      watchers: new Set(),
      subscribe(watcher) {
        sidebarState.watchers.add(watcher)
        return () => { sidebarState.watchers.delete(watcher) }
      },
      snapshot() {
        return sidebarState.width + '|' + sidebarState.view
      },
      emit() {
        for (const watcher of Array.from(sidebarState.watchers)) {
          try { watcher() } catch (err) { /* ignore */ }
        }
      },
      setWidth(next) {
        const value = typeof next === 'number' && isFinite(next) ? Math.max(0, Math.round(next)) : 0
        if (value === sidebarState.width) return
        sidebarState.width = value
        sidebarState.emit()
      },
      setView(next) {
        if (typeof next !== 'string' || next === sidebarState.view) return
        sidebarState.view = next
        sidebarState.emit()
      },
      isOpen() {
        return sidebarState.width > 24
      }
    }

    function sidebarSnapshot() {
      return sidebarState.snapshot()
    }

    function sidebarActiveView() {
      const wanted = sidebarState.view
      for (const tab of SIDEBAR_TABS) {
        if (tab.id === wanted) return wanted
      }
      return SIDEBAR_TABS[0].id
    }

    // 布局服务的开合口有两代：
    //   · 0.1.2：openDetails() / closeDetails()（右栏就是 details 列，宽度由布局钳在 300–520）
    //   · 0.1.5 起：openRightbar(track, fullscreen) / closeRightbar()（全局面板右栏）
    // 两代都探一遍，谁在就用谁。
    function openSidebar(view) {
      if (typeof view === 'string') sidebarState.setView(view)
      if (layout === null || layout === undefined) return
      if (typeof layout.openRightbar === 'function') {
        layout.openRightbar(true, false)
        return
      }
      if (typeof layout.openDetails === 'function') layout.openDetails()
    }

    function closeSidebar() {
      if (layout !== null && layout !== undefined) {
        if (typeof layout.closeRightbar === 'function') layout.closeRightbar()
        else if (typeof layout.closeDetails === 'function') layout.closeDetails()
      }
      sidebarState.setWidth(0)
    }

    function toggleSidebar(view) {
      if (sidebarState.isOpen()) closeSidebar()
      else openSidebar(view)
    }

    function describeError(error) {
      if (error === null || error === undefined) return String(error)
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    }

    // 页签体错误边界。需要 React.Component；拿不到就退化成直接渲染
    // —— 宁可少一层边界，也不要因为探测失败整列白屏。
    let TabBoundary = null
    if (React.Component !== undefined && React.Component !== null) {
      TabBoundary = class TabBoundaryImpl extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null, attempt: 0 }
          this.retry = this.retry.bind(this)
        }

        static getDerivedStateFromError(error) {
          return { error: error }
        }

        componentDidCatch(error) {
          console.error('[rsb] 页签渲染失败 | ' + describeError(error))
        }

        componentDidUpdate(previous) {
          if (previous.tabId !== this.props.tabId && this.state.error !== null) this.setState({ error: null })
        }

        retry() {
          this.setState({ error: null, attempt: this.state.attempt + 1 })
        }

        render() {
          if (this.state.error !== null) {
            return React.createElement('div', { className: 'rsb-error' },
              React.createElement('div', { className: 'rsb-error-title', key: 't' }, '这个页签渲染失败了'),
              React.createElement('div', { className: 'rsb-error-msg', key: 'm' }, describeError(this.state.error)),
              React.createElement('button', { className: 'rsb-act', key: 'r', type: 'button', onClick: this.retry }, '重试')
            )
          }
          return this.props.children
        }
      }
    }

    // 审查页签：内容就是原来的右栏面板（ReviewPanel 自带标题栏、统一/分栏、折叠、加宽）。
    function ReviewBody(props) {
      return React.createElement(ReviewPanel, props)
    }

    // 页面里量自己：优先 ResizeObserver（有就用），另加 500ms 兜底轮询
    // —— 拖分隔条 / 关列 / 切会话都会让宽度变化，而布局不通知我们。
    let sidebarElement = null
    function measureSidebar() {
      if (sidebarElement === null) return
      try {
        sidebarState.setWidth(sidebarElement.offsetWidth)
      } catch (err) { /* ignore */ }
    }

    function RightSidebar(props) {
      const source = props === null || props === undefined ? {} : props
      const sessionId = source.sessionId
      const tickState = React.useState(0)
      const setTick = tickState[1]

      React.useEffect(() => {
        const watcher = () => setTick((value) => value + 1)
        const off = sidebarState.subscribe(watcher)
        return () => { off() }
      }, [])

      React.useEffect(() => {
        if (sidebarElement === null) return undefined
        measureSidebar()
        let observer = null
        try {
          const doc = sidebarElement.ownerDocument
          const view = doc === null || doc === undefined ? null : doc.defaultView
          if (view !== null && view !== undefined && typeof view.ResizeObserver === 'function') {
            observer = new view.ResizeObserver(measureSidebar)
            observer.observe(sidebarElement)
          }
        } catch (err) { /* ignore */ }
        const tick = ctx.interval(measureSidebar, 500)
        return () => {
          try {
            if (observer !== null) observer.disconnect()
          } catch (err) { /* ignore */ }
          if (typeof tick === 'function') tick()
          sidebarElement = null
          sidebarState.setWidth(0)
        }
      }, [])

      const active = sidebarActiveView()
      const barChildren = []
      barChildren.push(React.createElement('div', { className: 'rsb-pills', key: 'pills' },
        SIDEBAR_TABS.map((tab) => React.createElement('button', {
          key: tab.id,
          type: 'button',
          className: 'rsb-pill',
          'data-active': tab.id === active ? 'true' : 'false',
          title: tab.hint === undefined ? tab.label : tab.hint,
          onClick: () => sidebarState.setView(tab.id)
        }, tab.label))
      ))
      barChildren.push(React.createElement('div', { className: 'rsb-bar-actions', key: 'acts' },
        React.createElement('button', {
          key: 'close',
          type: 'button',
          className: 'rsb-act',
          title: '收起右侧栏',
          'aria-label': '收起右侧栏',
          onClick: closeSidebar
        }, '\u2715')
      ))

      const panes = []
      for (const tab of SIDEBAR_TABS) {
        const body = React.createElement(tab.Body, { sessionId: sessionId, key: tab.id })
        panes.push(React.createElement('div', {
          key: tab.id,
          className: 'rsb-pane',
          'data-active': tab.id === active ? 'true' : 'false'
        }, TabBoundary === null ? body : React.createElement(TabBoundary, { tabId: tab.id }, body)))
      }

      return React.createElement('div', {
        className: 'rsb-root',
        ref: (el) => { if (el !== null && el !== undefined) sidebarElement = el }
      },
        React.createElement('div', { className: 'rsb-bar', key: 'bar' }, barChildren),
        React.createElement('div', { className: 'rsb-panes', key: 'panes' }, panes)
      )
    }

    // 顶部按钮：会话头部右侧的工具区（conversation.session.header.utilities，list 座位，零替换风险）。
    // 点一下就开/收右栏 —— 出厂界面原本没有任何入口能打开这一列。
    function HeaderReviewButton() {
      const tickState = React.useState(0)
      const setTick = tickState[1]

      React.useEffect(() => {
        const watcher = () => setTick((value) => value + 1)
        const off = sidebarState.subscribe(watcher)
        return () => { off() }
      }, [])

      const open = sidebarState.isOpen()
      return React.createElement('button', {
        className: 'rsb-hbtn',
        type: 'button',
        'data-active': open ? 'true' : 'false',
        title: open ? '收起审查栏' : '打开审查栏：列出本条消息的全部改动',
        'aria-label': open ? '收起审查栏' : '打开审查栏',
        onClick: () => openReviewColumn()
      },
        React.createElement('svg', {
          key: 'i',
          width: 15,
          height: 15,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        },
          React.createElement('rect', { key: 'r', x: 1.6, y: 2.6, width: 12.8, height: 10.8, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
          React.createElement('path', { key: 'd', d: 'M10.6 2.6v10.8', stroke: 'currentColor', strokeWidth: 1.3 })
        ),
        React.createElement('span', { className: 'rsb-hbtn-label', key: 'l' }, '审查')
      )
    }

    styles.insert([
      '.rsb-root{display:flex;flex-direction:column;height:100%;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base)}',
      '.rsb-bar{flex:0 0 auto;display:flex;align-items:center;gap:4px;height:36px;padding:0 6px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-1)}',
      '.rsb-pills{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden}',
      '.rsb-pill{max-width:150px;border:1px solid transparent;border-radius:7px;background:transparent;padding:2px 10px;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rsb-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.rsb-pill[data-active=true]{background:var(--dsw-alias-markdown-code-block);border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}',
      '.rsb-bar-actions{margin-left:auto;display:flex;align-items:center;gap:4px}',
      '.rsb-act{border:1px solid transparent;border-radius:6px;background:transparent;padding:1px 7px;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.rsb-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.rsb-panes{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      '.rsb-pane{flex:1 1 auto;min-height:0;display:none}',
      '.rsb-pane[data-active=true]{display:flex;flex-direction:column}',
      '.rsb-hbtn{display:inline-flex;align-items:center;gap:5px;border:1px solid transparent;border-radius:7px;background:transparent;padding:2px 8px;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.rsb-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.rsb-hbtn[data-active=true]{background:var(--dsw-alias-markdown-code-block);border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}',
      '.rsb-error{display:flex;flex-direction:column;gap:8px;padding:14px;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px)}',
      '.rsb-error-title{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rsb-error-msg{font-family:var(--ds-font-family-code,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:16px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-state-error-primary)}',
      '.rsb-load-error{padding:14px;color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);white-space:pre-wrap;word-break:break-word}'
    ].join('\n'))
