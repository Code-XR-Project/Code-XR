/**
 * Shared LivePanel page shell utilities.
 *
 * One implementation for every LivePanel template (file and directory):
 *  - theme persistence and toggling (both panels share one stored preference,
 *    'codexrLivePanelTheme'; charts restyle via CSS variables, no re-render);
 *  - the SSE connection status indicator (styles in panelShell.css);
 *  - transient notification toasts;
 *  - the DataTable registry (create once, update rows in place so live updates
 *    keep the user's search/sort state);
 *  - small shared formatters.
 *
 * Bundled by LivePanelParser ahead of each template's own script.
 */

// Theme management
function getStoredTheme() {
  try {
    return localStorage.getItem('codexrLivePanelTheme') || 'light';
  } catch (error) {
    console.warn('Failed to get stored theme:', error);
    return 'light';
  }
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem('codexrLivePanelTheme', theme);
  } catch (error) {
    console.warn('Failed to store theme:', error);
  }
}

const THEME_ICON_SUN = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>';
const THEME_ICON_MOON = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';

// Inline SVG icons for the theme toggle. Using icons (not the words "Dark" /
// "Light") keeps the control compact and language-neutral; `stroke: currentColor`
// in the stylesheet colors them for whichever theme is active.
function applyTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    // In dark mode, offer the sun (switch to light); in light mode, the moon.
    themeToggle.innerHTML = theme === 'dark' ? THEME_ICON_SUN : THEME_ICON_MOON;
    themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  }
  // Charts read their colors from CSS variables (charts.css), so switching the
  // body[data-theme] attribute restyles every chart with no re-render.
}

function toggleTheme() {
  const currentTheme = document.body.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  setStoredTheme(newTheme);
}

function showSSEStatus(status) {
  let statusElement = document.getElementById('sse-status');
  if (!statusElement) {
    statusElement = document.createElement('div');
    statusElement.id = 'sse-status';
    statusElement.className = 'sse-status';
    document.body.appendChild(statusElement);
  }

  switch (status) {
    case 'connected':
      statusElement.textContent = 'Live Updates';
      statusElement.style.backgroundColor = '#10b981';
      statusElement.style.color = 'white';
      break;
    case 'error':
      statusElement.textContent = 'Disconnected';
      statusElement.style.backgroundColor = '#ef4444';
      statusElement.style.color = 'white';
      break;
  }
}

let sseStatusFlashTimer = null;

/**
 * Momentarily surface that fresh data arrived, then fall back to the steady
 * "Live Updates" indicator.
 */
function flashSSEStatus(message) {
  const statusElement = document.getElementById('sse-status');
  if (!statusElement) {
    return;
  }
  statusElement.textContent = message;
  statusElement.style.backgroundColor = '#3b82f6';
  statusElement.style.color = 'white';
  if (sseStatusFlashTimer) {
    clearTimeout(sseStatusFlashTimer);
  }
  sseStatusFlashTimer = setTimeout(() => {
    sseStatusFlashTimer = null;
    showSSEStatus('connected');
  }, 2500);
}

/**
 * Connect a panel to its server's `/events` stream (SSE) and dispatch every
 * message type. Both LivePanel templates use this; what differs per panel is
 * passed in. EventSource reconnects on its own, so an error only updates the
 * status indicator; on the reconnect the historical panel re-reads the
 * comparison status, because events sent while the stream was down are lost
 * (HIST-13). Messages arrive flat (`{ type }`) or nested in the
 * EnhancedSSEManager envelope (`{ data: { type } }`).
 *
 * @param {Object} options
 * @param {string} options.label                Log prefix, e.g. 'FILE_ANALYSIS'.
 * @param {() => void} options.onAnalysisUpdated   The panel's data was re-analyzed.
 * @param {() => void} options.onDependencyUpdated The dependency dataset was rewritten.
 * @param {{handleSseMessage: (message: Object) => void, syncStatus: () => void}} options.historicalPanel
 * @param {(...args: unknown[]) => void} [options.trace]  Verbose diagnostics (default: none).
 * @returns {EventSource|null} also kept on `window.analysisSSE`.
 */
function createLivePanelSse(options) {
  const label = options.label;
  const trace = typeof options.trace === 'function' ? options.trace : function () {};

  function handleMessage(data) {
    const messageType = data.type || (data.data && data.data.type);
    trace(`${label}: Handling SSE message:`, messageType, data);

    switch (messageType) {
      case 'connected':
        showSSEStatus('connected');
        break;

      case 'analysis-updated':
        flashSSEStatus('New data received');
        options.onAnalysisUpdated();
        break;

      case 'dependency-updated':
        // The server recomputed the dependency dataset as part of re-analysis.
        flashSSEStatus('New data received');
        options.onDependencyUpdated();
        break;

      case 'historical-progress':
        // Comparison progress from the server (analyzing left/right versions).
        options.historicalPanel.handleSseMessage(data.data && data.data.type ? data.data : data);
        break;

      case 'historical-updated':
        // A comparison finished (or its working-copy side was re-analyzed).
        flashSSEStatus('New data received');
        options.historicalPanel.handleSseMessage(data.data && data.data.type ? data.data : data);
        break;

      case 'heartbeat':
        // Keep-alive message, no action needed.
        break;

      default:
        console.log(`${label}: Unknown SSE message type:`, messageType);
    }
  }

  trace(`${label}: Initializing SSE for live updates...`);
  try {
    const eventSource = new EventSource('/events');
    let openedBefore = false;

    eventSource.onopen = function () {
      trace(`${label}: SSE connection opened`);
      showSSEStatus('connected');
      if (openedBefore) {
        options.historicalPanel.syncStatus();
      }
      openedBefore = true;
    };

    eventSource.onmessage = function (event) {
      trace(`${label}: Raw SSE message received:`, event.data);
      try {
        handleMessage(JSON.parse(event.data));
      } catch (error) {
        console.error(`${label}: Error parsing SSE message:`, error);
        trace(`${label}: Unparseable data:`, event.data);
      }
    };

    eventSource.onerror = function (event) {
      // EventSource retries automatically; just reflect the state.
      trace(`${label}: SSE connection error:`, event);
      showSSEStatus('error');
    };

    window.analysisSSE = eventSource;
    return eventSource;
  } catch (error) {
    console.error(`${label}: Failed to initialize SSE:`, error);
    showSSEStatus('error');
    return null;
  }
}

/**
 * Show update notification
 */
function showUpdateNotification() {
  showNotification('Analysis updated! Refreshing data...', '#3b82f6', 3000);
}

/**
 * Show reload completion notification
 */
function showReloadNotification() {
  showNotification('Data refreshed successfully!', '#10b981', 2000);
}

/**
 * Show a temporary notification
 */
function showNotification(message, backgroundColor = '#3b82f6', duration = 3000) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 50px;
    right: 10px;
    background: ${backgroundColor};
    color: white;
    padding: 10px 15px;
    border-radius: 4px;
    font-size: 14px;
    z-index: 1001;
    font-family: inherit;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    animation: slideIn 0.3s ease;
  `;
  notification.textContent = message;
  
  document.body.appendChild(notification);
  
  // Remove notification after specified duration
  setTimeout(() => {
    notification.remove();
  }, duration);
}

// ── Table registry ───────────────────────────────────────────────────────────
// Every list in this view is a shared DataTable. Instances are cached by mount
// id so live updates (SSE reloads, dependency refresh) re-render existing tables
// instead of rebuilding them and losing the user's current search/sort.
const dataTables = {};

function upsertDataTable(mountId, options, rows) {
  if (dataTables[mountId]) {
    dataTables[mountId].setRows(rows);
  } else {
    dataTables[mountId] = new DataTable(mountId, Object.assign({}, options, { rows: rows }));
  }
  return dataTables[mountId];
}

/**
 * Metric value as the panels display it. Metrics arrive from the backend
 * already rounded, but anything derived from them (a delta, an average) is a
 * raw float: `5.44 - 8.86` is `-3.419999999999999`, and printing that verbatim
 * is how the comparison table ended up showing sixteen decimals. Integers keep
 * their exact form; everything else is shown at the same precision the metrics
 * themselves use.
 */
function formatMetricValue(value, decimals = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '0';
  }
  if (Number.isInteger(number)) {
    return String(number);
  }
  // Number() drops the trailing zeros toFixed() adds: 5.40 → "5.4".
  return String(Number(number.toFixed(decimals)));
}

function formatRatio(value) {
  return `${((value || 0) * 100).toFixed(1)}%`;
}
