// == liveChannel.js | the browser half of the live channel (epic #341) ==
//
// Every page an analysis server serves (XR scenes, DOM visualisations, the
// LivePanel) gets its live updates through this ONE runtime, over a WebSocket
// to /codexr-live on the page's own origin. It replaced the per-page
// EventSource('/events') clients and provides explicitly what SSE gave
// implicitly:
//  - reconnect with exponential back-off (1 s doubling to 30 s, +20% jitter),
//    reset once a greeting arrives;
//  - a watchdog: the server sends a heartbeat every 15 s, and a socket silent
//    for three heartbeats is treated as half-open (laptop slept, Wi-Fi
//    changed) and replaced;
//  - resync: every message carries the channel's revision and the server's
//    epoch; when the greeting after a reconnect shows a different one, the
//    page's onResync hook runs once so it re-reads what it missed.
//
// The constants mirror src/core/server/live/liveChannelProtocol.ts (a unit
// test keeps them in step). Classic script: it may be bundled more than once
// into a page, so it defines the global only once.
(function (root) {
  'use strict';
  if (root.CodeXRLiveChannel) {
    return;
  }

  let LIVE_CHANNEL_PATH = '/codexr-live';
  let LIVE_HEARTBEAT_INTERVAL_MS = 15000;
  let LIVE_CLIENT_SILENCE_TIMEOUT_MS = LIVE_HEARTBEAT_INTERVAL_MS * 3;
  let LIVE_RECONNECT_MIN_DELAY_MS = 1000;
  let LIVE_RECONNECT_MAX_DELAY_MS = 30000;
  let LIVE_CLOSE_REMOVED = 4001;

  function nextReconnectDelay(previousDelayMs, random) {
    let base = previousDelayMs > 0
      ? Math.min(LIVE_RECONNECT_MAX_DELAY_MS, previousDelayMs * 2)
      : LIVE_RECONNECT_MIN_DELAY_MS;
    return Math.min(LIVE_RECONNECT_MAX_DELAY_MS, Math.round(base * (1 + 0.2 * random)));
  }

  function needsResync(last, greeting) {
    if (!last) {
      return false;
    }
    return last.epoch !== greeting.epoch || greeting.revision !== last.revision;
  }

  function liveChannelUrl(location) {
    let protocol = location && location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + (location && location.host ? location.host : 'localhost') + LIVE_CHANNEL_PATH;
  }

  /**
   * Opens the live channel and keeps it open until close() is called.
   *
   * @param {Object} options
   * @param {(message: Object) => void} [options.onMessage] every parsed message
   *   except heartbeats (the greeting `connected` included).
   * @param {(status: string) => void} [options.onStatus] 'connecting' | 'open' |
   *   'reconnecting' | 'disabled'.
   * @param {(greeting: Object) => void} [options.onResync] the greeting of a
   *   reconnect that missed at least one update (or a restarted server).
   * @param {boolean} [options.disabled] never connect (offline exports).
   * @param {string} [options.url] defaults to /codexr-live on this origin.
   * @param {Function} [options.WebSocket] seams for the tests.
   * @param {Function} [options.setTimeout]
   * @param {Function} [options.clearTimeout]
   * @param {() => number} [options.random]
   * @returns {{ close: () => void, getStatus: () => string }}
   */
  function connect(options) {
    options = options || {};
    let WebSocketImpl = options.WebSocket || root.WebSocket;
    let schedule = options.setTimeout || function (fn, ms) { return root.setTimeout(fn, ms); };
    let cancel = options.clearTimeout || function (handle) { root.clearTimeout(handle); };
    let random = options.random || Math.random;
    let url = options.url || liveChannelUrl(root.location);
    let onMessage = typeof options.onMessage === 'function' ? options.onMessage : function () {};
    let onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};
    let onResync = typeof options.onResync === 'function' ? options.onResync : function () {};

    let socket = null;
    let status = '';
    let closed = false;
    let reconnectDelayMs = 0;
    let reconnectTimer = null;
    let watchdogTimer = null;
    let lastSeen = null;

    function setStatus(next) {
      if (status === next) {
        return;
      }
      status = next;
      try {
        onStatus(next);
      } catch (error) {
        console.error('[CodeXR live] status handler failed:', error);
      }
    }

    function clearWatchdog() {
      if (watchdogTimer !== null) {
        cancel(watchdogTimer);
        watchdogTimer = null;
      }
    }

    function armWatchdog(current) {
      clearWatchdog();
      watchdogTimer = schedule(function () {
        watchdogTimer = null;
        if (current === socket) {
          // Half-open: nothing arrived for three heartbeats. Drop it and let
          // onclose schedule the reconnect.
          try {
            current.close();
          } catch (_error) {
            // already closing
          }
          handleClosed(current);
        }
      }, LIVE_CLIENT_SILENCE_TIMEOUT_MS);
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer !== null) {
        return;
      }
      reconnectDelayMs = nextReconnectDelay(reconnectDelayMs, random());
      setStatus('reconnecting');
      reconnectTimer = schedule(function () {
        reconnectTimer = null;
        open();
      }, reconnectDelayMs);
    }

    function handleClosed(current) {
      if (current !== socket) {
        return;
      }
      socket = null;
      clearWatchdog();
      scheduleReconnect();
    }

    function handleMessage(current, event) {
      if (current !== socket) {
        return;
      }
      armWatchdog(current);
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.error('[CodeXR live] unparseable message:', error);
        return;
      }
      if (!message || typeof message.type !== 'string') {
        return;
      }
      let seen = typeof message.epoch === 'string' && typeof message.revision === 'number'
        ? { epoch: message.epoch, revision: message.revision }
        : null;
      if (message.type === 'connected') {
        reconnectDelayMs = 0;
        setStatus('open');
        let resync = seen !== null && needsResync(lastSeen, seen);
        if (seen) {
          lastSeen = seen;
        }
        dispatch(message);
        if (resync) {
          try {
            onResync(message);
          } catch (error) {
            console.error('[CodeXR live] resync handler failed:', error);
          }
        }
        return;
      }
      if (seen) {
        lastSeen = seen;
      }
      if (message.type !== 'heartbeat') {
        dispatch(message);
      }
    }

    function dispatch(message) {
      try {
        onMessage(message);
      } catch (error) {
        console.error('[CodeXR live] message handler failed:', error);
      }
    }

    function open() {
      if (closed) {
        return;
      }
      setStatus(lastSeen || reconnectDelayMs > 0 ? 'reconnecting' : 'connecting');
      let current;
      try {
        current = new WebSocketImpl(url);
      } catch (error) {
        console.error('[CodeXR live] cannot open the live channel:', error);
        scheduleReconnect();
        return;
      }
      socket = current;
      armWatchdog(current);
      current.onmessage = function (event) { handleMessage(current, event); };
      current.onclose = function (event) {
        // 4001: the host removed this person. Their session is revoked, so
        // every retry would be refused; stop instead (COLLAB-SYNC-10).
        if (event && event.code === LIVE_CLOSE_REMOVED) {
          closed = true;
          setStatus('disabled');
        }
        handleClosed(current);
      };
      current.onerror = function () {
        // onclose follows every error; the reconnect is scheduled there.
      };
    }

    if (options.disabled || !WebSocketImpl) {
      closed = true;
      setStatus('disabled');
    } else {
      open();
    }

    return {
      close: function () {
        closed = true;
        if (reconnectTimer !== null) {
          cancel(reconnectTimer);
          reconnectTimer = null;
        }
        clearWatchdog();
        let current = socket;
        socket = null;
        if (current) {
          try {
            current.close(1000, 'page closed the live channel');
          } catch (_error) {
            // already closed
          }
        }
        setStatus('disabled');
      },
      getStatus: function () {
        return status;
      },
    };
  }

  root.CodeXRLiveChannel = {
    connect: connect,
    url: liveChannelUrl,
    nextReconnectDelay: nextReconnectDelay,
    needsResync: needsResync,
    constants: {
      LIVE_CHANNEL_PATH: LIVE_CHANNEL_PATH,
      LIVE_HEARTBEAT_INTERVAL_MS: LIVE_HEARTBEAT_INTERVAL_MS,
      LIVE_CLIENT_SILENCE_TIMEOUT_MS: LIVE_CLIENT_SILENCE_TIMEOUT_MS,
      LIVE_RECONNECT_MIN_DELAY_MS: LIVE_RECONNECT_MIN_DELAY_MS,
      LIVE_RECONNECT_MAX_DELAY_MS: LIVE_RECONNECT_MAX_DELAY_MS,
      LIVE_CLOSE_REMOVED: LIVE_CLOSE_REMOVED,
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
