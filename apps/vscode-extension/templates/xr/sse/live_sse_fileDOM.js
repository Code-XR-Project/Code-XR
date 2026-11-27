/**
 * HTML Live Reload Client
 * Manages live updates for HTML DOM visualization in both standard and XR modes
 */

// Debug mode - set to true to trace live reload in the browser console.
// Same convention as the LivePanel scripts (DEBUG_MODE + debugLog), with
// page-unique names: this is a classic script sharing the page's global scope.
const LIVE_RELOAD_DEBUG_MODE = false;

function liveReloadDebugLog(...args) {
  if (LIVE_RELOAD_DEBUG_MODE) {
    console.log(...args);
  }
}

liveReloadDebugLog('Setting up EventSource for HTML live reload...');

let eventSource = null;
let isXRMode = false;
let hadConnectionError = false;
let reconnectDelayMs = 0;
let reconnectTimer = null;
const RECONNECT_MIN_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

function checkXRMode() {
  isXRMode = !!document.querySelector('a-scene');
  liveReloadDebugLog(isXRMode ? 'XR mode detected' : 'Standard mode detected');
  return isXRMode;
}

function getCurrentDistanceLevel(entity) {
  const currentConfig = entity.getAttribute('babia-html');
  return currentConfig && typeof currentConfig.distanceLevels === 'number'
    ? currentConfig.distanceLevels
    : 0.7;
}

function applyBabiaHtmlComponent(entity, htmlContent, distanceLevels) {
  window.__CODEXR_DOM_HTML_PAYLOAD__ = htmlContent;
  entity.removeAttribute('babia-html');
  requestAnimationFrame(() => {
    entity.setAttribute('babia-html', {
      renderHTML: true,
      renderHTMLOnlyLeafs: true,
      html: htmlContent,
      distanceLevels,
    });
  });
}

document.addEventListener('DOMContentLoaded', checkXRMode);

// Opens the connection and binds every handler to it. An error used to
// reload the page after 3 s whatever happened: with the server down that
// replaced the visualization with the browser's error page, and with
// /events answering 404 the page reloaded forever. Now the browser's own
// retry is left alone, a connection it gave up on is reopened with back-off,
// and the page reloads only once a connection is back after an error (to
// pick up any update missed while it was down).
function connectLiveReload() {
  reconnectTimer = null;
  const source = new EventSource('/events');
  eventSource = source;
  source.onopen = function () {
    reconnectDelayMs = 0;
    liveReloadDebugLog('HTML EventSource connection established');
    if (hadConnectionError) {
      hadConnectionError = false;
      liveReloadDebugLog('Connection restored after an error; reloading to catch up...');
      location.reload();
      return;
    }
    liveReloadDebugLog('DOM Visualization live reload ready - file changes will update automatically');
  };
  source.onerror = function (err) {
    if (source !== eventSource) {
      return;
    }
    console.error('HTML EventSource error:', err);
    hadConnectionError = true;
    if (source.readyState !== 2) {
      return;
    }
    source.close();
    if (!reconnectTimer) {
      reconnectDelayMs = reconnectDelayMs
        ? Math.min(RECONNECT_MAX_DELAY_MS, reconnectDelayMs * 2)
        : RECONNECT_MIN_DELAY_MS;
      reconnectTimer = setTimeout(connectLiveReload, reconnectDelayMs);
    }
  };
  source.addEventListener('message', handleLiveReloadMessage);
  return source;
}

function handleLiveReloadMessage(event) {
    try {
        const data = JSON.parse(event.data);
        liveReloadDebugLog('SSE received:', data);
        
        if (data.type === 'htmlUpdated' && data.action === 'reload-html') {
            liveReloadDebugLog('HTML content updated, updating babia-html component...');
            
            let entity = document.querySelector('#htmlDOM');
            if (!entity) {
                console.warn('#htmlDOM entity not found, falling back to page reload');
                location.reload();
                return;
            }

            if (!data.htmlContent) {
                console.warn('No htmlContent received in DOM SSE message; reloading page');
                location.reload();
                return;
            }
            
            updateBabiaHtmlComponent(entity, data.htmlContent);
            
        } else if (data.type === 'analysis-updated' && data.action === 'reload-data') {
            liveReloadDebugLog('Analysis data updated, refreshing...');
            location.reload();
        }
    } catch (error) {
        console.error('Error parsing SSE message:', error);
    }
}

function updateBabiaHtmlComponent(entity, htmlContent) {
    try {
        liveReloadDebugLog('Updating babia-html component with new content...');
        const distanceLevels = getCurrentDistanceLevel(entity);
        applyBabiaHtmlComponent(entity, htmlContent, distanceLevels);
        liveReloadDebugLog('babia-html component updated successfully');
    } catch (error) {
        console.error('Failed to update babia-html component:', error);
        liveReloadDebugLog('Falling back to page reload...');
        location.reload();
    }
}

connectLiveReload();
