/**
 * Headless smoke test for the follow-until-screen decision logic.
 *
 * It mocks only the DOM surface the client module touches, drives the
 * scheduler frame by frame, and asserts the release points. Run with:
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.resolve(here, '..', 'client.js')

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = { ...attributes }
    this.children = []
    this.parent = null
    this.hidden = false
    this.rect = { top: 0, height: 0 }
    this.events = []
  }

  append(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  remove(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parent = null
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
  }

  getClientRects() {
    return this.hidden ? [] : [{}]
  }

  getBoundingClientRect() {
    return { ...this.rect }
  }

  dispatchEvent(event) {
    this.events.push(event)
    return true
  }

  matches(selector) {
    const parts = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)]
    if (parts.length === 0) return false
    return parts.every(([, name, value]) => {
      const actual = this.getAttribute(name)
      if (actual === null) return false
      return value === undefined || actual === value
    })
  }

  querySelectorAll(selector) {
    const found = []
    const walk = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) found.push(child)
        walk(child)
      }
    }
    walk(this)
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

// --- scheduler -------------------------------------------------------------
let nextId = 1
const frameQueue = new Map()
const timerQueue = new Map()
let loaded = null

globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded = module.factory()
    },
  },
  requestAnimationFrame(callback) {
    const id = nextId++
    frameQueue.set(id, callback)
    return id
  },
  cancelAnimationFrame(id) {
    frameQueue.delete(id)
  },
  setTimeout(callback) {
    const id = nextId++
    timerQueue.set(id, callback)
    return id
  },
  clearTimeout(id) {
    timerQueue.delete(id)
  },
}

// --- DOM -------------------------------------------------------------------
const documentRoot = new FakeElement()

globalThis.document = {
  querySelector: (selector) => documentRoot.querySelector(selector),
  querySelectorAll: (selector) => documentRoot.querySelectorAll(selector),
}

globalThis.WheelEvent = class WheelEvent {
  constructor(type, init = {}) {
    this.type = type
    this.deltaY = init.deltaY
    this.bubbles = init.bubbles
  }
}

function mountConversation() {
  const port = documentRoot.append(new FakeElement({ 'data-conversation-scroll': '' }))
  port.rect = { top: 0, height: 800 }
  port.scrollTop = 1000
  const flow = port.append(new FakeElement({ 'data-chat-flow': '' }))
  return { port, flow }
}

function addUserRow(flow, turn) {
  return flow.append(new FakeElement({
    'data-chat-flow-kind': 'user',
    'data-chat-turn': String(turn),
  }))
}

function addResponseRow(flow, turn, top, height) {
  const row = flow.append(new FakeElement({
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-group-part': 'response',
    'data-chat-turn': String(turn),
  }))
  row.rect = { top, height }
  return row
}

function addReasoningRow(flow, turn) {
  const row = flow.append(new FakeElement({
    'data-chat-flow-kind': 'assistant-step',
    'data-chat-group-part': 'reasoning',
    'data-chat-turn': String(turn),
  }))
  row.append(new FakeElement({ 'data-variant': 'think' }))
  return row
}

function addRunning(flow) {
  return flow.append(new FakeElement({ 'data-chat-running': '' }))
}

function flushFrame() {
  const entry = frameQueue.entries().next().value
  if (entry === undefined) return false
  frameQueue.delete(entry[0])
  entry[1]()
  return true
}

function flushTimers() {
  while (timerQueue.size > 0) {
    const entry = timerQueue.entries().next().value
    timerQueue.delete(entry[0])
    entry[1]()
  }
}

await import(pathToFileURL(clientPath).href)
assert.ok(loaded !== null, 'client module registered with the loader')

const cleanups = []
const context = {
  effect(callback) {
    const cleanup = callback()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  },
}
loaded.apply(context)

const { port, flow } = mountConversation()
// dsh-smooth-stream owns the scrollport while it writes; its own release path
// lands past the Harness band, so the plugin must not add a second nudge.
port.attributes['data-follow-owned'] = 'active'
// The Harness reports tail-following on the Chat root while it owns the
// bottom band; the plugin only adds the real scroll nudge in that state.
const baseFollow = port.append(new FakeElement({ 'data-chat-following-tail': '' }))

// Turn 1: the answer starts below the fold and grows past one screen.
const turnOneRunning = addRunning(flow)
addUserRow(flow, 1)
const firstAnswer = addResponseRow(flow, 1, 500, 100)
for (const top of [400, 300, 200, 100, 40, 20]) {
  firstAnswer.rect.top = top
  assert.equal(flushFrame(), true, 'the follower keeps a frame scheduled while the answer streams')
}
assert.equal(port.events.length, 1, 'one wheel intent is dispatched when the answer fills one screen')
assert.equal(port.events[0].type, 'wheel')
assert.ok(port.events[0].deltaY < 0)
assert.equal(port.scrollTop, 1000, 'smooth-stream releases without an extra scroll nudge')

firstAnswer.rect.top = 0
flushFrame()
assert.equal(port.events.length, 1, 'the same answer row is released only once')

// Turn 2: a new turn re-arms and releases at the same threshold.
addUserRow(flow, 2)
const secondAnswer = addResponseRow(flow, 2, 500, 100)
for (const top of [300, 100, 20]) {
  secondAnswer.rect.top = top
  flushFrame()
}
assert.equal(port.events.length, 2, 'a later turn releases again')
assert.equal(port.scrollTop, 1000, 'the host nudge stays with smooth-stream while it owns the port')

// Turn 3: a short answer never reaches the threshold.
flow.remove(turnOneRunning)
addUserRow(flow, 3)
const shortAnswer = addResponseRow(flow, 3, 300, 60)
for (let index = 0; index < 3; index += 1) {
  shortAnswer.rect.top = 300
  flushFrame()
}
assert.equal(port.events.length, 2, 'a short answer is not released')

// Turn 4: only a reasoning row exists; it must never count as the answer.
addRunning(flow)
addUserRow(flow, 4)
const reasoning = addReasoningRow(flow, 4)
for (let index = 0; index < 3; index += 1) {
  reasoning.rect.top = 10
  flushFrame()
}
assert.equal(port.events.length, 2, 'a reasoning row does not trigger the release')

// Turn 5: an old answer row is visible and a new turn is running, but the new
// answer row has not mounted yet. The old row must not be re-released.
addUserRow(flow, 5)
for (let index = 0; index < 2; index += 1) {
  shortAnswer.rect.top = 10
  flushFrame()
}
assert.equal(port.events.length, 2, 'the previous turn answer is not used for a new turn')

// Turn 6: neither owner follows. The wheel is still harmless.
port.remove(baseFollow)
delete port.attributes['data-follow-owned']
addUserRow(flow, 6)
const thirdAnswer = addResponseRow(flow, 6, 500, 100)
for (const top of [300, 100, 20]) {
  thirdAnswer.rect.top = top
  flushFrame()
}
assert.equal(port.events.length, 3, 'the wheel is dispatched even when no owner follows')
assert.equal(port.scrollTop, 1000, 'no scroll nudge without Harness tail-following')

// Turn 7: the Harness owns the scroll (smooth-stream is off). The wheel alone
// only stops its native animation, so a real displacement must release it.
port.append(new FakeElement({ 'data-chat-following-tail': '' }))
addUserRow(flow, 7)
const fourthAnswer = addResponseRow(flow, 7, 500, 100)
for (const top of [300, 100, 20]) {
  fourthAnswer.rect.top = top
  flushFrame()
}
assert.equal(port.events.length, 4, 'the wheel is dispatched when the Harness follows')
assert.equal(port.scrollTop, 968, 'the Harness is nudged out of its follow band by real displacement')

for (const cleanup of cleanups) cleanup()
flushTimers()
assert.equal(frameQueue.size, 0, 'disposing cancels the pending frame')

console.log('follow-until-screen smoke test: OK')
