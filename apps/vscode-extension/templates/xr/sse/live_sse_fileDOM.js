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

const eventSource = new EventSource('/events');
let isXRMode = false;

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

eventSource.onopen = function () {
  liveReloadDebugLog('HTML EventSource connection established');
  liveReloadDebugLog('DOM Visualization live reload ready - file changes will update automatically');
};

eventSource.onerror = function (err) {
  console.error('HTML EventSource error:', err);
  setTimeout(() => {
    liveReloadDebugLog('Attempting to reconnect HTML EventSource...');
    eventSource.close();
    location.reload();
  }, 3000);
};

eventSource.addEventListener('message', function(event) {
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
});

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
