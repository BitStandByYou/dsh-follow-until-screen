/**
 * Stop tail-following once the current turn's final answer fills one screen.
 *
 * Both the Harness ChatView and dsh-smooth-stream treat a wheel intent with a
 * negative deltaY on the conversation scroller as "the reader took over".
 * When the answer row's top reaches the top of the scrollport, this plugin
 * dispatches one such intent, so both layers release the bottom pin. It reads
 * only Harness conversation markers, never another plugin's internal state.
 */
window.__ModuleLoader__.load({
  id: 'dsh-follow-until-screen',
  factory() {
    const PORT_SELECTOR = '[data-conversation-scroll]'
    const FLOW_SELECTOR = '[data-chat-flow]'
    const ANSWER_PART_SELECTOR = '[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]'
    const ASSISTANT_SELECTOR = '[data-chat-flow-kind="assistant-step"]'
    const RUNNING_SELECTOR = '[data-chat-running]'
    const TURN_ATTR = 'data-chat-turn'
    /** About one line: release before the first line is clipped by the top edge. */
    const TOP_MARGIN_PX = 24
    /** Keep frame timing while a reply is still growing after the turn closes. */
    const GROWTH_WINDOW_MS = 2000
    const IDLE_POLL_MS = 400
    const RELEASE_DELTA_Y = -120
    /**
     * The Harness releases follow only from a real scroll displacement beyond
     * its 25px bottom band. When dsh-smooth-stream owns the scroll it already
     * lands at 26px past that band on release, so the wheel intent is enough.
     * Only when the Harness itself follows do we add the displacement.
     */
    const RELEASE_SCROLL_UP_PX = 32

    function install() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

      const released = new WeakSet()
      const tracked = new WeakMap()
      let handle = 0
      let handleIsFrame = false
      let disposed = false
      let lastGrowthAt = 0

      const now = () => performance.now()

      /** Latest loaded turn in this flow, read from the tail of the DOM order. */
      function latestTurn(flow) {
        const rows = flow.querySelectorAll(`[${TURN_ATTR}]`)
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const raw = rows[index].getAttribute(TURN_ATTR)
          if (raw === null) continue
          const value = Number(raw)
          if (Number.isFinite(value)) return value
        }
        return Number.NEGATIVE_INFINITY
      }

      function visible(row) {
        return !row.hidden
          && !row.hasAttribute('data-turn-process-hidden')
          && row.getClientRects().length > 0
      }

      function turnOf(row) {
        const raw = row.getAttribute(TURN_ATTR)
        if (raw === null) return Number.NaN
        return Number(raw)
      }

      /**
       * The final answer row of the given turn. On 0.2.x the assistant step is
       * split into reasoning and response rows; only the response row contains
       * the answer. Older layouts have a single assistant row, where the Think
       * block is the only part to exclude.
       */
      function answerRow(flow, turn) {
        const rows = flow.querySelectorAll(ANSWER_PART_SELECTOR)
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]
          if (turnOf(row) !== turn) continue
          if (visible(row)) return row
        }
        if (rows.length > 0) return null
        const assistantRows = flow.querySelectorAll(ASSISTANT_SELECTOR)
        for (let index = assistantRows.length - 1; index >= 0; index -= 1) {
          const row = assistantRows[index]
          if (turnOf(row) !== turn) continue
          if (row.querySelector('[data-variant="think"]') !== null) continue
          if (visible(row)) return row
        }
        return null
      }

      function release(port) {
        if (typeof WheelEvent !== 'function') return false
        // A smooth-stream follower owns the port while it carries this marker.
        // Its release path lands beyond the Harness follow band by itself, so
        // adding our own displacement there would push the answer down twice.
        const smoothOwnsScroll = port.hasAttribute('data-follow-owned')
        port.dispatchEvent(new WheelEvent('wheel', {
          deltaY: RELEASE_DELTA_Y,
          bubbles: false,
          cancelable: false,
          composed: false,
        }))
        if (!smoothOwnsScroll && port.querySelector('[data-chat-following-tail]') !== null) {
          port.scrollTop = Math.max(0, port.scrollTop - RELEASE_SCROLL_UP_PX)
        }
        return true
      }

      /** @returns whether this port still needs frame-level timing. */
      function checkPort(port, running) {
        const flow = port.querySelector(FLOW_SELECTOR)
        if (flow === null) return false
        const turn = latestTurn(flow)
        if (!Number.isFinite(turn)) return false
        const row = answerRow(flow, turn)
        if (row === null || released.has(row)) return false

        const rect = row.getBoundingClientRect()
        const portRect = port.getBoundingClientRect()
        const filled = rect.top <= portRect.top + TOP_MARGIN_PX

        let state = tracked.get(row)
        if (state === undefined) {
          state = { armed: false, height: rect.height, grewAt: 0 }
          tracked.set(row, state)
        } else if (Math.abs(rect.height - state.height) > 0.5) {
          state.height = rect.height
          state.grewAt = now()
          lastGrowthAt = state.grewAt
        }

        const active = running || now() - state.grewAt < GROWTH_WINDOW_MS
        if (!state.armed) {
          if (!active) return false
          state.armed = true
        } else if (!active) {
          return false
        }
        if (!filled) return true
        if (!release(port)) return false
        released.add(row)
        return false
      }

      function scan() {
        const running = document.querySelector(RUNNING_SELECTOR) !== null
        let wanted = false
        for (const port of document.querySelectorAll(PORT_SELECTOR)) {
          if (checkPort(port, running)) wanted = true
        }
        return running || wanted || now() - lastGrowthAt < GROWTH_WINDOW_MS
      }

      function cancel() {
        if (handle === 0) return
        if (handleIsFrame) window.cancelAnimationFrame(handle)
        else window.clearTimeout(handle)
        handle = 0
      }

      function schedule(frames) {
        if (disposed) return
        if (handle !== 0 && frames === handleIsFrame) return
        cancel()
        handleIsFrame = frames
        handle = frames
          ? window.requestAnimationFrame(tick)
          : window.setTimeout(tick, IDLE_POLL_MS)
      }

      function tick() {
        handle = 0
        if (disposed) return
        schedule(scan())
      }

      schedule(true)
      return () => {
        disposed = true
        cancel()
      }
    }

    return {
      inject: [],
      apply(ctx) {
        if (typeof ctx.effect === 'function') ctx.effect(() => install())
        else install()
      },
    }
  },
})
