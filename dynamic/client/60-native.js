    // ═══════════ 原生右侧栏适配层（DSH 0.1.5-rc.1 起） ═══════════
    //
    // 两代 DSH 的右栏机制不一样，这份源码两路都带，运行时自己选：
    //
    //   · 0.1.5-rc.1 起：右栏是**原生栏**，壳自带页签条/固定/引导页，插件只提供「页签类型」+
    //     「页签体」（`ctx.sidebarRightTabs.register(...)` + keyed 槽 `sidebar.right.pane.tab`）。
    //     开合与页签管理交给宿主，`ctx.sidebarRight.openTab(kind)` 只对在屏会话写入。
    //   · 0.1.2：没有这套服务（`sidebarRight` / `sidebarRightTabs` 都不存在，本机实测），
    //     只能自己占 details 槽做整列（本仓库的 50-sidebar.js 就是这一路）。
    //
    // 做法：先按自建外壳装（0.1.2 上唯一可用的路，装完立刻可用）；同时用
    // `ctx.inject(['sidebarRightTabs'], …)` **等服务出现**——一旦出现就撤掉自建外壳、把页签交给原生栏。
    //
    // 为什么必须等「服务」不能等「槽声明」：原生栏先声明 `sidebar.right.pane.tab`、随后才
    // `provide('sidebarRightTabs')`，按槽声明触发注册会读到 undefined 且永不重试（静默什么都不注册）。
    // 这条是 dsh-better-sidebar（omdsh-dev/DSH-better-sidebar）在真机 profile 上实测记录的，
    // 见其 AGENTS.md §3 第 10 条与 docs/external-plan-2026-08-19 的承载面设计。
    //
    // 原生页签体的宿主 `.paneBody` 是**有确定高度的块级滚动容器**（不是 flex 容器），所以页签体
    // 外面自己再包一层 height:100% 的列 flex 宿主（.rsb-native-host），否则根盒会塌成内容高度。

    let nativeDisposers = []
    let nativeActive = false
    let fallbackInjection = null

    function nativeRegistry() {
      const registry = ctx.get('sidebarRightTabs')
      return registry === undefined || registry === null ? null : registry
    }

    function nativeSidebar() {
      const right = ctx.get('sidebarRight')
      return right === undefined || right === null ? null : right
    }

    function nativeTabId(tab) {
      return 'dsh-turn-changes:' + tab.id
    }

    function disposeAll(disposers) {
      for (const dispose of disposers) {
        try { dispose() } catch (err) { /* ignore */ }
      }
    }

    /** 一个宿主页签体：外面套确定高度的列 flex 宿主，里面再套页签错误边界。 */
    function nativeBodyFor(tab) {
      return function NativeTabBody(props) {
        const source = props === null || props === undefined ? {} : props
        const sessionId = source.sessionId
        const body = React.createElement(tab.Body, { sessionId: sessionId })
        return React.createElement('div', { className: 'rsb-native-host' },
          TabBoundary === null ? body : React.createElement(TabBoundary, { tabId: tab.id }, body))
      }
    }

    function installNative(registry) {
      if (nativeActive === true) return
      nativeActive = true
      // 原生栏接管同一块地方：先把自建外壳撤掉，否则 details 列会与原生栏并存打架。
      releaseFallback()
      try {
        for (const tab of SIDEBAR_TABS) {
          const id = nativeTabId(tab)
          const entry = {
            id: id,
            kind: tab.id,
            // 外部实现要压过产品自带的查看器；这里是页签类型，写成 extension 与参考实现一致。
            priority: 'extension',
            title: () => tab.label
          }
          if (typeof tab.hint === 'string' && tab.hint.length > 0) {
            entry.guide = [{
              order: typeof tab.order === 'number' ? tab.order : 100,
              title: () => tab.label,
              description: () => tab.hint
            }]
          }
          nativeDisposers.push(registry.register(entry))
          // 页签体挂 keyed 槽；槽本身由原生栏声明，注册用 slots.inject 等它到位。
          nativeDisposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: id
          }, nativeBodyFor(tab))))
        }
        console.log('[rsb] 原生右侧栏已接管 | ' + SIDEBAR_TABS.length + ' 个页签类型')
        // 顶部按钮可能是「为了看审查页签才把原生列挂起来」的，这时要把页签补开一下。
        if (pendingReviewOpen === true) {
          pendingReviewOpen = false
          const right = nativeSidebar()
          if (right !== null && typeof right.openTab === 'function') right.openTab('review')
        }
      } catch (err) {
        console.error('[rsb] 原生右侧栏注册失败 | ' + describeError(err))
      }
    }

    function releaseNative() {
      if (nativeActive !== true) return
      nativeActive = false
      disposeAll(nativeDisposers)
      nativeDisposers = []
    }

    /** 自建外壳（details 整列）：0.1.2 的路。 */
    function installFallback() {
      if (nativeActive === true || fallbackInjection !== null) return
      fallbackInjection = slots.inject('details', () => {
        if (detailsRegistration === null) {
          detailsRegistration = slots.register({ name: 'details' }, RightSidebar)
        }
        return () => {
          if (detailsRegistration !== null) {
            try { detailsRegistration() } catch (err) { /* ignore */ }
            detailsRegistration = null
          }
        }
      })
    }

    function releaseFallback() {
      if (detailsRegistration !== null) {
        try { detailsRegistration() } catch (err) { /* ignore */ }
        detailsRegistration = null
      }
      if (fallbackInjection !== null) {
        try { fallbackInjection() } catch (err) { /* ignore */ }
        fallbackInjection = null
      }
    }

    // 顶部按钮的落点，按可用性依次降级：
    //   1. 原生栏服务已在（列已挂起来）→ 直接开我们的审查页签（ctx.sidebarRight.openTab(kind)）；
    //   2. 还没有服务，但布局有 openRightbar（0.1.5 起）→ 先把原生列挂起来（挂载时它才 provide
    //      sidebarRight 服务），记下待开标记，等下面的 inject 回调接管后立刻把审查页签打开；
    //   3. 都没有（0.1.2）→ 开自建 details 列。
    let pendingReviewOpen = false

    function openReviewColumn() {
      if (nativeActive === true) {
        const right = nativeSidebar()
        if (right !== null && typeof right.openTab === 'function') {
          try {
            right.openTab('review')
            return
          } catch (err) {
            console.error('[rsb] 原生右栏 openTab 失败 | ' + describeError(err))
          }
        }
      }
      if (layout !== null && layout !== undefined && typeof layout.openRightbar === 'function') {
        pendingReviewOpen = true
        try {
          layout.openRightbar(true, false)
          return
        } catch (err) {
          console.error('[rsb] openRightbar 失败 | ' + describeError(err))
        }
      }
      toggleSidebar('review')
    }

    // 等服务出现：0.1.2 上永不触发（保持自建外壳）；0.1.5+ 上服务在启动后到位，随即接管。
    ctx.inject(['sidebarRightTabs'], (injected) => {
      const registry = injected === undefined || injected === null ? null : injected.get('sidebarRightTabs')
      if (registry === undefined || registry === null) return
      installNative(registry)
      return () => {
        releaseNative()
        installFallback()
      }
    })

    styles.insert([
      '.rsb-native-host{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}',
      '.rsb-native-host>*{flex:1 1 auto;min-height:0}'
    ].join('\n'))
