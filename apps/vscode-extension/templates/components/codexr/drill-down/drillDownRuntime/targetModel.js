// == drillDownRuntime.js | targetModel (assembled per manifest.json; see COMPONENTS.md) ==
  // Pure helpers: what a picked Babia element is, and how the crumbs fit the
  // bar. Babia boats hangs the data on its entities as `babiaRawData`: a
  // building carries its data row (directory analysis: one file, `filePath`;
  // file analysis: one function, `functionName` + `lineStart`), a district
  // the tree node `{ uid, name, children }` whose uid is the folder path
  // without its leading slash (the tree splits `filePath` on '/').

  /** Forward slashes, no drive letter, no doubled or trailing slash, one leading slash. */
  function normalizePath(value) {
    var normalized = String(value == null ? '' : value).replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(normalized)) { normalized = normalized.slice(2); }
    normalized = normalized.replace(/\/{2,}/g, '/');
    if (normalized.length > 1) { normalized = normalized.replace(/\/+$/, ''); }
    if (normalized && normalized.charAt(0) !== '/') { normalized = '/' + normalized; }
    return normalized;
  }

  /** A drilled tree's uids carry the namespace; the classic chart's do not. */
  function stripNamespace(uid) {
    var value = String(uid == null ? '' : uid);
    var prefix = UID_NAMESPACE + ':';
    return value.indexOf(prefix) === 0 ? value.slice(prefix.length) : value;
  }

  function parentPath(absolutePath) {
    var normalized = normalizePath(absolutePath);
    var index = normalized.lastIndexOf('/');
    return index <= 0 ? '/' : normalized.slice(0, index);
  }

  function baseName(absolutePath) {
    var normalized = normalizePath(absolutePath);
    return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
  }

  /** `absolutePath` relative to the boundary root ('' for the root), or null when outside it. */
  function relativeTo(rootPath, absolutePath) {
    if (!rootPath) { return null; }
    var rootValue = normalizePath(rootPath);
    var target = normalizePath(absolutePath);
    // Windows and macOS spell one folder several ways; the server decides for real.
    var fold = function (value) { return value.toLowerCase(); };
    if (fold(target) === fold(rootValue)) { return ''; }
    var prefix = rootValue === '/' ? '/' : rootValue + '/';
    return fold(target).indexOf(fold(prefix)) === 0 ? target.slice(prefix.length) : null;
  }

  /**
   * What the picked element stands for, or null when it carries no data we
   * can drill from. `context`: `{ viewKind, rootPath, currentPath }`, where
   * viewKind is the kind of analysis the chart shows ('file' | 'directory'),
   * currentPath the analysed file when it is a file analysis, and treeBase
   * the folder a drilled tree's relative district uids hang from.
   */
  function targetFromRaw(raw, context) {
    if (!raw || typeof raw !== 'object') { return null; }
    var settings = context || {};
    var target;
    if (raw.functionName !== undefined && raw.filePath) {
      var filePath = normalizePath(raw.filePath);
      target = {
        type: 'function',
        label: String(raw.functionName || 'function'),
        path: filePath,
        filePath: filePath,
        line: Number(raw.lineStart) > 0 ? Number(raw.lineStart) : null,
        lineEnd: Number(raw.lineEnd) > 0 ? Number(raw.lineEnd) : null
      };
    } else if (Array.isArray(raw.children)) {
      if (settings.viewKind === 'file') {
        // A file analysis groups functions under one district: the file itself.
        var analysed = normalizePath(settings.currentPath || '');
        target = { type: 'file', label: String(raw.name || baseName(analysed)), path: analysed, filePath: analysed, line: null };
      } else {
        // The tree's root district (build_root) has no uid: it is the base itself.
        var relativeUid = stripNamespace(raw.uid == null ? '' : raw.uid);
        var folderPath = settings.treeBase
          ? normalizePath(relativeUid ? settings.treeBase + '/' + relativeUid : settings.treeBase)
          : normalizePath(stripNamespace(raw.uid || raw.name));
        target = { type: 'folder', label: String(raw.name || baseName(folderPath)), path: folderPath, filePath: null, line: null };
      }
    } else if (raw.filePath) {
      var fileOnly = normalizePath(raw.filePath);
      target = { type: 'file', label: String(raw.fileName || raw.name || baseName(fileOnly)), path: fileOnly, filePath: fileOnly, line: null };
    } else {
      return null;
    }
    target.folderPath = target.type === 'folder' ? target.path : parentPath(target.filePath || target.path);
    target.relativePath = relativeTo(settings.rootPath, target.path);
    target.folderRelativePath = relativeTo(settings.rootPath, target.folderPath);
    target.inside = target.relativePath !== null;
    return target;
  }

  /** Walks up from a picked element to the first one carrying Babia data, without leaving the chart. */
  function findRawData(element, chartEl) {
    var node = element;
    while (node && node !== chartEl && node.nodeType === 1) {
      if (node.babiaRawData) { return { element: node, raw: node.babiaRawData }; }
      node = node.parentNode;
    }
    return null;
  }

  /** The chart entity (classic or drilled) an element belongs to, or null. */
  function pickableChartOf(element) {
    var node = element;
    while (node && node.nodeType === 1) {
      if (node.id && PICKABLE_CHART_IDS.indexOf(node.id) !== -1) { return node; }
      node = node.parentNode;
    }
    return null;
  }

  /** Plate width for a crumb label (metres): readable, bounded. */
  function crumbWidth(label) {
    return Math.min(1.5, Math.max(0.42, 0.2 + String(label || '').length * 0.085));
  }

  /**
   * Fits the crumbs into `maxWidth`: the first (the root) and the last ones
   * always show; the middle collapses into one '...' crumb that jumps to the
   * deepest hidden ancestor.
   */
  function layoutCrumbs(crumbs, maxWidth, gap) {
    var list = Array.isArray(crumbs) ? crumbs : [];
    var spacing = gap == null ? 0.16 : gap;
    var total = function (items) {
      return items.reduce(function (sum, item) { return sum + crumbWidth(item.ellipsis ? '...' : item.label) + spacing; }, 0) - spacing;
    };
    if (list.length <= 2 || total(list) <= maxWidth) { return list.slice(); }
    for (var keep = list.length - 2; keep >= 1; keep -= 1) {
      var tail = list.slice(list.length - keep);
      var hidden = list.slice(1, list.length - keep);
      var candidate = [list[0], { ellipsis: true, label: '...', kind: 'directory', relativePath: hidden[hidden.length - 1].relativePath }].concat(tail);
      if (total(candidate) <= maxWidth || keep === 1) {
        if (keep === 1) {
          candidate[candidate.length - 1] = Object.assign({}, candidate[candidate.length - 1], {
            label: compact(candidate[candidate.length - 1].label, Math.max(6, Math.floor((maxWidth - total(candidate.slice(0, -1)) - spacing - 0.2) / 0.085)))
          });
        }
        return candidate;
      }
    }
    return list.slice();
  }

  function formatElapsed(ms) {
    var seconds = Math.max(0, Number(ms) || 0) / 1000;
    return seconds < 10 ? seconds.toFixed(1) + ' s' : Math.round(seconds) + ' s';
  }

  /** The bar's info line for a ready entity. */
  function describeReady(entityState) {
    if (!entityState) { return ''; }
    if (entityState.message) { return entityState.message; }
    if (entityState.atHome) { return 'Select a building or a district and choose Analyze to drill into it.'; }
    var count = Number(entityState.rowCount) || 0;
    var noun = entityState.target?.kind === 'file' ? (count === 1 ? 'function' : 'functions') : (count === 1 ? 'file' : 'files');
    var analyzed = Number(entityState.analyzedCount) || 0;
    var reused = Number(entityState.reusedCount) || 0;
    var origin;
    if (entityState.target?.kind === 'file') {
      origin = analyzed ? 'freshly analysed' : 'up to date, nothing analysed';
    } else {
      origin = analyzed ? reused + ' reused, ' + analyzed + ' analysed' : 'all up to date, nothing analysed';
    }
    return count + ' ' + noun + ': ' + origin + '.';
  }
