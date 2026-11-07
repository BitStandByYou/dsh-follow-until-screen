/**
 * Stop tail-following once the current turn's final answer fills one screen.
 *
 * Both the Harness ChatView and dsh-smooth-stream treat a wheel intent with a
 * negative deltaY on the conversation scroller as "the reader took over".
 * When the answer row's top reaches the top of the scrollport, this plugin
 * dispatches one such intent, so both layers release the bottom pin. It reads
 * only Harness conversation markers, never another plugin's internal state.
 *
 * The same rule is re-applied when a Session that was left while still
 * tail-following is shown again. The Harness has no saved reading position for
 * such a Session, so it lands on the floor again; the answer may have grown
 * past one screen while the view was away. In that case the plugin puts the
 * answer's first line back near the top edge instead of leaving the reader at
 * the bottom. A Session left with a saved reading position keeps the
 * Harness's restored position, and the first visit to a Session in this page
 * lifetime is never repositioned.
 */
window.__ModuleLoader__.load({
  id: 'dsh-follow-until-screen',
  factory() {
    const PORT_SELECTOR = '[data-conversation-scroll]'
    const SESSION_SELECTOR = '[data-conversation-session]'
    const FLOW_SELECTOR = '[data-chat-flow]'
    const ANSWER_PART_SELECTOR = '[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]'
    const ASSISTANT_SELECTOR = '[data-chat-flow-kind="assistant-step"]'
    const RUNNING_SELECTOR = '[data-chat-running]'
    const FOLLOW_ATTR = 'data-chat-following-tail'
    const FOLLOW_OWNED_ATTR = 'data-follow-owned'
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
    /** How long a returned view may keep asking for its answer top. */
    const ARRIVAL_WINDOW_MS = 6000
    /** How long to keep re-applying the top after the Harness repairs its floor. */
    const ARRIVAL_CONFIRM_MS = 1500
    /** Reader input that means the person is choosing a position themselves. */
    const INTENT_TYPES = ['wheel', 'touchstart', 'pointerdown', 'keydown']

    function install() {
      if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}

      const released = new WeakSet()
      const tracked = new WeakMap()
      /** Per-port hint that the view just became visible again. */
      const arrivals = new WeakMap()
      /** Whether each Session was still tail-following when it was last visible. */
      const departures = new Map()
      const visiblePorts = new WeakMap()
      /** Chat flow element last seen in each resident scrollport. */
      const flows = new WeakMap()
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

      function shown(element) {
        return element.getClientRects().length > 0 && element.getBoundingClientRect().height > 0.5
      }

      function turnOf(row) {
        const raw = row.getAttribute(TURN_ATTR)
        if (raw === null) return Number.NaN
        return Number(raw)
      }

      /** Whether the Harness still pins the view to the floor. */
      function followingTail(port) {
        return port.querySelector(`[${FOLLOW_ATTR}]`) !== null
      }

      /** Whether any owner currently writes the scroll position. */
      function followsTail(port) {
        return followingTail(port) || port.hasAttribute(FOLLOW_OWNED_ATTR)
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

      function dispatchReaderIntent(port) {
        if (typeof WheelEvent !== 'function') return false
        port.dispatchEvent(new WheelEvent('wheel', {
          deltaY: RELEASE_DELTA_Y,
          bubbles: false,
          cancelable: false,
          composed: false,
        }))
        return true
      }

      function release(port) {
        // A smooth-stream follower owns the port while it carries this marker.
        // Its release path lands beyond the Harness follow band by itself, so
        // adding our own displacement there would push the answer down twice.
        const smoothOwnsScroll = port.hasAttribute(FOLLOW_OWNED_ATTR)
        if (!dispatchReaderIntent(port)) return false
        if (!smoothOwnsScroll && followingTail(port)) {
          port.scrollTop = Math.max(0, port.scrollTop - RELEASE_SCROLL_UP_PX)
        }
        return true
      }

      /**
       * Land the visible part of the answer on its first line: the answer top
       * sits about one line below the scrollport's top edge, matching where
       * streaming releases the reader mid-reply.
       */
      function alignToAnswerTop(port, portRect, rect) {
        const max = Math.max(0, port.scrollHeight - port.clientHeight)
        const target = Math.max(0, Math.min(max, port.scrollTop + rect.top - portRect.top - TOP_MARGIN_PX))
        // Release follow first: a native follow animation would otherwise
        // overwrite the landing, and smooth-stream must stop writing the floor.
        dispatchReaderIntent(port)
        if (Math.abs(target - port.scrollTop) > 0.5) port.scrollTop = target
      }

      /** Remember whether this Session was still following when it was last shown. */
      function rememberDeparture(port) {
        const root = port.closest(SESSION_SELECTOR)
        if (root === null) return
        const sessionId = root.getAttribute('data-conversation-session')
        if (sessionId === null) return
        departures.set(sessionId, { following: followsTail(port) })
      }

      /**
       * Note a view that just became visible again, or whose Chat flow was
       * replaced inside the resident conversation scrollport. A Session seen
       * before in this page lifetime can be told apart from a first visit, so
       * only a real return re-applies the one-screen rule.
       */
      function noteMount(port, shownNow, flow) {
        const wasVisible = visiblePorts.get(port)
        const previousFlow = flows.get(port)
        const remounted = shownNow && flow !== null && flow !== previousFlow
        if (shownNow && (remounted || wasVisible !== true)) {
          const root = port.closest(SESSION_SELECTOR)
          const sessionId = root === null ? null : root.getAttribute('data-conversation-session')
          const departure = sessionId === null ? undefined : departures.get(sessionId)
          arrivals.set(port, {
            at: now(),
            armed: departure !== undefined && departure.following,
            done: false,
            alignedAt: 0,
            turn: undefined,
          })
        }
        if (shownNow && flow !== null) flows.set(port, flow)
        visiblePorts.set(port, shownNow)
      }

      /** Re-apply the answer top while a returned view still sits on the floor. */
      function checkArrival(port, turn, rect, portRect) {
        const arrival = arrivals.get(port)
        if (arrival === undefined || arrival.done || !arrival.armed) return false
        if (!followsTail(port) || now() - arrival.at > ARRIVAL_WINDOW_MS) {
          arrival.done = true
          return false
        }
        if (arrival.alignedAt !== 0) {
          if (arrival.turn !== turn || now() - arrival.alignedAt > ARRIVAL_CONFIRM_MS) {
            arrival.done = true
            return false
          }
        }
        if (rect.top < portRect.top - 0.5) {
          arrival.turn = turn
          arrival.alignedAt = now()
          alignToAnswerTop(port, portRect, rect)
          return true
        }
        return arrival.alignedAt !== 0
      }

      /** @returns whether this port still needs frame-level timing. */
      function checkPort(port, running) {
        const flow = port.querySelector(FLOW_SELECTOR)
        if (flow === null) return false
        const turn = latestTurn(flow)
        if (!Number.isFinite(turn)) return false
        const row = answerRow(flow, turn)
        if (row === null) return false

        const rect = row.getBoundingClientRect()
        const portRect = port.getBoundingClientRect()
        if (checkArrival(port, turn, rect, portRect)) return true

        // A returned view keeps its answer already released for later growth.
        if (released.has(row)) return false

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

      /** Reader input means the person picked a position; stop re-applying ours. */
      function cancelArrival(event) {
        if (event.isTrusted !== true) return
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        const port = target.closest(PORT_SELECTOR)
        if (port === null) return
        const arrival = arrivals.get(port)
        if (arrival !== undefined) arrival.done = true
      }

      function scan() {
        const running = document.querySelector(RUNNING_SELECTOR) !== null
        let wanted = false
        for (const port of document.querySelectorAll(PORT_SELECTOR)) {
          const shownNow = shown(port)
          const flow = shownNow ? port.querySelector(FLOW_SELECTOR) : null
          noteMount(port, shownNow, flow)
          if (!shownNow) continue
          if (checkPort(port, running)) wanted = true
          rememberDeparture(port)
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

      for (const type of INTENT_TYPES) {
        document.addEventListener(type, cancelArrival, { capture: true, passive: true })
      }

      schedule(true)
      return () => {
        disposed = true
        cancel()
        for (const type of INTENT_TYPES) {
          document.removeEventListener(type, cancelArrival, { capture: true })
        }
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
