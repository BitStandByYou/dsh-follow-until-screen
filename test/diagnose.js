/**
 * Paste into the Web UI DevTools console while a long answer is streaming.
 * Prints the DOM facts the plugin depends on, so a failure can be attributed
 * to loading, selectors, or the Harness follow state.
 */
(() => {
  const port = document.querySelector('[data-conversation-scroll]');
  if (port === null) return 'no [data-conversation-scroll] on this page';
  const flow = port.querySelector('[data-chat-flow]');
  const rows = flow === null
    ? []
    : [...flow.querySelectorAll('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]')];
  const last = rows.at(-1);
  const portRect = port.getBoundingClientRect();
  const scroller = port.scrollHeight - port.clientHeight > 0.5;
  return JSON.stringify({
    moduleLoader: typeof window.__ModuleLoader__,
    pluginRegistered: (() => {
      try {
        const loader = window.__ModuleLoader__;
        const text = typeof loader?.list === 'function' ? JSON.stringify(loader.list()) : '';
        return text.includes('dsh-follow-until-screen');
      } catch { return 'unknown'; }
    })(),
    portFound: true,
    portIsScroller: scroller,
    followingTail: port.hasAttribute('data-chat-following-tail'),
    followOwned: port.hasAttribute('data-follow-owned'),
    flowFound: flow !== null,
    responseRows: rows.length,
    lastRow: last
      ? {
          turn: last.getAttribute('data-chat-turn'),
          hidden: last.hidden,
          processHidden: last.hasAttribute('data-turn-process-hidden'),
          top: Math.round(last.getBoundingClientRect().top),
        }
      : null,
    portTop: Math.round(portRect.top),
    filled: last !== null && last.getBoundingClientRect().top <= portRect.top + 24,
    latestTurns: flow === null
      ? []
      : [...flow.querySelectorAll('[data-chat-turn]')].slice(-6).map((node) => node.getAttribute('data-chat-turn')),
    scroll: {
      top: Math.round(port.scrollTop),
      floor: Math.round(port.scrollHeight - port.clientHeight),
    },
  }, null, 1);
})()
