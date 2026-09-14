    // ═══════════════════ 挂载与轮询 ═══════════════════

    let headerRegistration = null

    // 回合尾部卡片（已改动 N 个文件 +A −M）。
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

    // 占用右侧栏（details 槽）并挂右侧栏外壳 —— 这是 DSH 0.1.2 这一代唯一可用的路。
    // 该槽是 single，运行时会给动态注册的条目分配一个比出厂条目更低的秩
    // （dsh-cordis-client-runner/lib/client.js:266-271），priority 参数会被丢弃，遮蔽由框架保证。
    // 宿主一旦提供原生右侧栏服务（0.1.5-rc.1+），60-native.js 的 ctx.inject 会撤掉这条路并改挂原生页签。
    installFallback()

    // 顶部按钮：会话头部右侧工具区（出厂这里只有一个「下载会话日志」）。
    ctx.effect(() => slots.inject('conversation.session.header.utilities', () => {
      if (headerRegistration === null) {
        headerRegistration = slots.register({
          id: 'turn-changes-review',
          order: 20,
          label: '审查'
        }, HeaderReviewButton)
      }
      return () => {
        if (headerRegistration !== null) {
          try { headerRegistration() } catch (err) { /* ignore */ }
          headerRegistration = null
        }
      }
    }))

    // Host 启动时会把落盘的历史变更集随第一次轮询一起送来，所以这里不需要单独的索引调用。
    async function pump() {
      while (!stopped) {
        let result = null
        try {
          result = await host.call('turn-changes/poll', { since: revision })
        } catch (err) {
          result = null
        }
        if (stopped) return
        if (result !== null && result !== undefined && typeof result === 'object') {
          if (typeof result.revision === 'number') revision = result.revision
          if (absorb(result.entries) && refreshEntry !== null) refreshEntry()
          if (result.closed === true) return
        } else {
          await new Promise((resolve) => { ctx.timeout(() => resolve(null), RETRY_DELAY_MS) })
        }
      }
    }
    pump()

    ctx.effect(() => () => { stopped = true })
