// == agentFlowRuntime.js | timelineModel (assembled per manifest.json; see COMPONENTS.md) ==
  // Pure model: dataset -> ordered timeline -> the city's state at any step.
  // Seeking is a recomputation (stateAt), never an undo log, so it is
  // idempotent; only a forward single step animates (see playbackMachine.js).
  // Step positions are timeline INDEXES (0..steps-1, -1 = before the first
  // step); a dataset's `seq` is kept on each entry for display and joins.

  function toNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeFile(file, index) {
    var touches = file?.touches || {};
    return {
      index: index,
      path: String(file?.path || ''),
      name: String(file?.name || String(file?.path || '').split('/').pop() || ''),
      dir: String(file?.dir || ''),
      language: file?.language || '',
      loc: Math.max(0, toNumber(file?.loc, 0)),
      complexity: toNumber(file?.complexity, 0),
      x: toNumber(file?.x, 0),
      z: toNumber(file?.z, 0),
      w: Math.max(0.005, toNumber(file?.w, 0.05)),
      d: Math.max(0.005, toNumber(file?.d, 0.05)),
      h: Math.max(CITY.minHeight, toNumber(file?.h, CITY.minHeight)),
      baseY: Number.isFinite(Number(file?.baseY)) && file?.baseY !== null && file?.baseY !== undefined ? Number(file.baseY) : undefined,
      touches: {
        reads: toNumber(touches.reads, 0), writes: toNumber(touches.writes, 0),
        searches: toNumber(touches.searches, 0), executes: toNumber(touches.executes, 0)
      },
      firstStep: toNumber(file?.firstStep, -1),
      lastStep: toNumber(file?.lastStep, -1),
      turns: Array.isArray(file?.turns) ? file.turns.map(Number) : [],
      created: file?.created === true,
      deleted: file?.deleted === true,
      delta: file?.delta && typeof file.delta === 'object'
        ? { codeLines: toNumber(file.delta.codeLines, 0), complexity: toNumber(file.delta.complexity, 0) }
        : null,
      dependents: toNumber(file?.dependents, -1)
    };
  }

  /**
   * Files a step removes, as indexes. `step.deleted` may list indexes or
   * paths; without it a file flagged deleted is removed by its last step
   * (resolved in stateAt, which knows the file's lastStep).
   */
  function deletedFilesOf(step, files, validFile) {
    if (!Array.isArray(step.deleted)) { return []; }
    return step.deleted.map(function (entry) {
      if (typeof entry === 'number') { return entry; }
      var path = String(entry || '');
      var found = files.find(function (file) { return file.path === path || (path && path.endsWith('/' + file.path)); });
      return found ? found.index : -1;
    }).filter(validFile);
  }

  /**
   * The workers on the table. actors[0] is always the main agent; a dataset
   * from before multi-agent tracing gets that one actor synthesized.
   */
  function normalizeActors(rawActors, steps, session) {
    var list = Array.isArray(rawActors) ? rawActors.filter(function (actor) { return actor && typeof actor === 'object'; }) : [];
    var actors = list.map(function (actor, order) {
      return {
        index: order,
        id: String(actor.id || (order === 0 ? 'main' : 'agent-' + order)),
        label: String(actor.label || (order === 0 ? session.agent || 'Agent' : 'Subagent ' + order)),
        kind: order === 0 ? 'main' : 'subagent',
        parent: order === 0 ? null : Math.max(0, Math.min(order - 1, Math.floor(toNumber(actor.parent, 0)))),
        spawnStep: actor.spawnStep === null || actor.spawnStep === undefined ? null : toNumber(actor.spawnStep, null),
        steps: Math.max(0, toNumber(actor.steps, 0))
      };
    });
    if (!actors.length) {
      actors.push({ index: 0, id: 'main', label: String(session.agent || 'Agent'), kind: 'main', parent: null, spawnStep: null, steps: 0 });
    }
    // Older traces flag a subagent step with `subagent: true` and no actor.
    return actors;
  }

  /** Defensive copy with every array present; null for something that is not a dataset. */
  function normalizeDataset(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.files)) { return null; }
    var files = raw.files.map(normalizeFile);
    var fileCount = files.length;
    var validFile = function (index) { return Number.isInteger(index) && index >= 0 && index < fileCount; };
    var steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .filter(function (step) { return step && typeof step === 'object'; })
      .map(function (step, order) {
        return Object.assign({}, step, {
          seq: toNumber(step.seq, order),
          turn: Math.max(0, toNumber(step.turn, 0)),
          kind: String(step.kind || 'other'),
          status: String(step.status || 'done'),
          title: String(step.title || step.tool || step.kind || 'Step'),
          tool: String(step.tool || ''),
          files: (Array.isArray(step.files) ? step.files : []).map(Number).filter(validFile),
          actor: Math.max(0, Math.floor(toNumber(step.actor, 0))),
          spawns: step.spawns === undefined || step.spawns === null ? null : Math.floor(toNumber(step.spawns, -1)),
          deletes: deletedFilesOf(step, files, validFile)
        });
      })
      .sort(function (a, b) { return a.seq - b.seq; });
    var session = Object.assign({ id: '', agent: 'Agent', label: '', live: false }, raw.session || {});
    var actors = normalizeActors(raw.actors, steps, session);
    steps.forEach(function (step) {
      if (step.actor >= actors.length) { step.actor = 0; }
      if (step.spawns !== null && !(step.spawns > 0 && step.spawns < actors.length)) { step.spawns = null; }
    });
    return {
      normalized: true,
      schemaVersion: toNumber(raw.schemaVersion, 1),
      revision: toNumber(raw.revision, 0),
      rootName: String(raw.rootName || ''),
      plateHeight: Number(raw.plateHeight) > 0 ? Number(raw.plateHeight) : (Number(raw.layout?.plateHeight) > 0 ? Number(raw.layout.plateHeight) : undefined),
      session: session,
      actors: actors,
      files: files,
      districts: (Array.isArray(raw.districts) ? raw.districts : []).map(function (district) {
        return {
          path: String(district?.path || ''), depth: Math.max(1, toNumber(district?.depth, 1)),
          x: toNumber(district?.x, 0), z: toNumber(district?.z, 0),
          w: Math.max(0, toNumber(district?.w, 0)), d: Math.max(0, toNumber(district?.d, 0)),
          y: district?.y === null || district?.y === undefined ? undefined : toNumber(district.y, undefined)
        };
      }),
      turns: Array.isArray(raw.turns) ? raw.turns.slice() : [],
      steps: steps,
      transitions: (Array.isArray(raw.transitions) ? raw.transitions : []).filter(function (move) {
        return validFile(Number(move?.from)) && validFile(Number(move?.to));
      }),
      metrics: Object.assign({}, raw.metrics || {}),
      blastRadius: (Array.isArray(raw.blastRadius) ? raw.blastRadius : []).filter(function (entry) {
        return validFile(Number(entry?.file));
      }).map(function (entry) {
        return { file: Number(entry.file), dependents: (entry.dependents || []).map(Number).filter(validFile) };
      }),
      warnings: Array.isArray(raw.warnings) ? raw.warnings.slice() : []
    };
  }

  function isFailedStep(step) {
    if (step.status === 'failed') { return true; }
    return step.kind === 'execute' && step.exitCode !== undefined && step.exitCode !== null && Number(step.exitCode) !== 0;
  }

  function stepTarget(step) {
    if (step.kind === 'execute') { return { type: 'console', files: step.files.slice() }; }
    if (!step.files.length) { return { type: 'none', files: [] }; }
    if (step.kind === 'search') { return { type: 'files', files: step.files.slice() }; }
    return { type: 'file', files: step.files.slice(), primary: step.files[0] };
  }

  function emptyCounts() {
    return { read: 0, search: 0, write: 0, execute: 0, other: 0, failed: 0 };
  }

  function countKind(counts, step) {
    var key = Object.prototype.hasOwnProperty.call(counts, step.kind) && step.kind !== 'failed' ? step.kind : 'other';
    counts[key] += 1;
    if (step.failed) { counts.failed += 1; }
  }

  /**
   * Per file, the share of its net line change reached after each of its
   * writes: exact from the steps' added/removed when every write knows them,
   * otherwise spread evenly across the writes.
   */
  function buildWritePlan(steps, files) {
    var writes = {};
    steps.forEach(function (step) {
      if (step.kind !== 'write') { return; }
      step.files.forEach(function (fileIndex) {
        (writes[fileIndex] = writes[fileIndex] || []).push(step);
      });
    });
    var plan = {};
    Object.keys(writes).forEach(function (key) {
      var list = writes[key];
      var file = files[Number(key)];
      var nets = list.map(function (step) {
        return step.added === undefined && step.removed === undefined
          ? null : toNumber(step.added, 0) - toNumber(step.removed, 0);
      });
      var exact = nets.every(function (net) { return net !== null; });
      var sumNet = exact ? nets.reduce(function (a, b) { return a + b; }, 0) : 0;
      var totalDelta = file.delta ? file.delta.codeLines : sumNet;
      var running = 0;
      var shares = {};
      list.forEach(function (step, order) {
        running += exact ? nets[order] : 0;
        shares[step.index] = exact && sumNet !== 0 ? running / sumNet : (order + 1) / list.length;
      });
      plan[key] = { shares: shares, totalDelta: totalDelta, baseLoc: file.created ? 0 : Math.max(0, file.loc - totalDelta) };
    });
    return plan;
  }

  /** Ordered steps with turn boundaries and per-step targets. */
  function buildTimeline(dataset) {
    var data = dataset?.normalized ? dataset : normalizeDataset(dataset);
    if (!data) { return { steps: [], turns: [], turnStarts: [], count: 0, writePlan: {} }; }
    var steps = data.steps.map(function (step, index) {
      var entry = Object.assign({}, step, { index: index });
      entry.failed = isFailedStep(entry);
      entry.target = stepTarget(entry);
      return entry;
    });
    var actors = buildActorLanes(data, steps);
    var turnMap = {};
    (data.turns || []).forEach(function (turn, order) {
      var index = toNumber(turn?.index, order);
      turnMap[index] = { index: index, prompt: String(turn?.prompt || ''), start: -1, end: -1, counts: emptyCounts() };
    });
    steps.forEach(function (step) {
      var turn = turnMap[step.turn] || (turnMap[step.turn] = { index: step.turn, prompt: '', start: -1, end: -1, counts: emptyCounts() });
      if (turn.start < 0) { turn.start = step.index; }
      turn.end = step.index;
      countKind(turn.counts, step);
    });
    var turns = Object.keys(turnMap).map(function (key) { return turnMap[key]; })
      .sort(function (a, b) { return a.index - b.index; });
    turns.forEach(function (turn, order) { turn.order = order; turn.label = 'T' + (turn.index + 1); });
    return {
      steps: steps,
      turns: turns,
      turnStarts: turns.filter(function (turn) { return turn.start >= 0; }).map(function (turn) { return turn.start; }),
      count: steps.length,
      writePlan: buildWritePlan(steps, data.files),
      actors: actors
    };
  }

  /**
   * Per actor: its steps in order, where it spawned and when it is done. Also
   * links every step to the previous/next step OF THE SAME ACTOR (actions of
   * different actors overlap; an action lasts until that actor moves on) and
   * marks blind writes (a write to a file no actor had read before).
   */
  function buildActorLanes(data, steps) {
    var actors = (data.actors || [{ index: 0, id: 'main', label: 'Agent', kind: 'main', parent: null, spawnStep: null }]).map(function (actor) {
      return {
        index: actor.index, id: actor.id, label: actor.label, kind: actor.kind, parent: actor.parent,
        color: actorColor(actor.index), steps: [], spawnIndex: -1, firstIndex: -1, lastIndex: -1
      };
    });
    var lastOf = {};
    var readFiles = {};
    steps.forEach(function (step) {
      var lane = actors[step.actor] || actors[0];
      step.actorPrev = lastOf[lane.index] === undefined ? null : lastOf[lane.index];
      step.actorNext = null;
      if (step.actorPrev !== null) { steps[step.actorPrev].actorNext = step.index; }
      lastOf[lane.index] = step.index;
      lane.steps.push(step.index);
      if (lane.firstIndex < 0) { lane.firstIndex = step.index; }
      lane.lastIndex = step.index;
      if (step.kind === 'delegate' && step.spawns !== null && actors[step.spawns] && actors[step.spawns].spawnIndex < 0) {
        actors[step.spawns].spawnIndex = step.index;
      }
      step.blind = [];
      if (step.kind === 'write') {
        step.files.forEach(function (fileIndex) {
          var file = data.files[fileIndex];
          var creates = file?.created && file.firstStep === step.seq;
          if (!readFiles[fileIndex] && !creates) { step.blind.push(fileIndex); }
        });
      }
      if (step.kind === 'read' || step.kind === 'write') {
        step.files.forEach(function (fileIndex) { readFiles[fileIndex] = true; });
      }
    });
    // A dataset's spawnStep (a seq) wins when no delegate step names the actor.
    actors.forEach(function (lane, order) {
      var spawnSeq = data.actors?.[order]?.spawnStep;
      if (lane.spawnIndex < 0 && spawnSeq !== null && spawnSeq !== undefined) {
        lane.spawnIndex = steps.findIndex(function (step) { return step.seq === spawnSeq; });
      }
    });
    return actors;
  }

  /**
   * Where every worker is at the playhead. A worker is present from its spawn
   * (main: always) until its last step is over; its current action is its
   * latest step at or before the playhead, and that action is ongoing until
   * the same worker's next step starts (or, for its final step, while the
   * playhead is on it or the step is still running).
   */
  function workersAt(timeline, index) {
    var at = Math.floor(toNumber(index, -1));
    return (timeline?.actors || []).map(function (lane) {
      var current = -1;
      for (var i = lane.steps.length - 1; i >= 0; i -= 1) {
        if (lane.steps[i] <= at) { current = lane.steps[i]; break; }
      }
      var step = current >= 0 ? timeline.steps[current] : null;
      var start = lane.kind === 'main' ? -Infinity : (lane.spawnIndex >= 0 ? lane.spawnIndex : lane.firstIndex);
      var ended = lane.kind !== 'main' && lane.lastIndex >= 0 && at > lane.lastIndex
        && timeline.steps[lane.lastIndex].status !== 'running';
      var present = timeline.count > 0 && (lane.kind === 'main' || (start >= 0 && at >= start && !ended));
      var ongoing = !!step && (step.actorNext !== null ? at < step.actorNext : (at === current || step.status === 'running'));
      return {
        actor: lane.index,
        present: present,
        stepIndex: current,
        step: step,
        active: present && ongoing,
        finished: ended
      };
    });
  }

  /** Building height for a line count, on the builder's sqrt(loc) scale anchored at the file's final height. */
  function heightForLoc(file, loc) {
    var min = CITY.minHeight;
    if (!(loc > 0) || !(file.loc > 0)) { return min; }
    var height = min + (file.h - min) * Math.sqrt(loc / file.loc);
    return Math.max(min, Math.min(CITY.maxHeight * 1.25, height));
  }

  function initialFileState(file, plan) {
    var entry = plan[file.index];
    return {
      touches: { reads: 0, writes: 0, searches: 0, executes: 0 },
      turns: [],
      created: file.created,
      deleted: false,
      visible: !file.created,
      height: file.created ? 0 : (entry ? heightForLoc(file, entry.baseLoc) : file.h),
      lastIndex: -1,
      lastKind: null,
      blind: false
    };
  }

  var TOUCH_KEY = { read: 'reads', write: 'writes', search: 'searches', execute: 'executes' };

  function applyStepToFile(fileState, file, step, plan) {
    var key = TOUCH_KEY[step.kind];
    if (key) { fileState.touches[key] += 1; }
    if (fileState.turns.indexOf(step.turn) < 0) { fileState.turns.push(step.turn); }
    fileState.lastIndex = step.index;
    fileState.lastKind = step.kind;
    if (step.kind === 'write') {
      var entry = plan[file.index];
      var share = entry ? toNumber(entry.shares[step.index], 1) : 1;
      fileState.height = entry ? heightForLoc(file, entry.baseLoc + entry.totalDelta * share) : file.h;
      fileState.visible = true;
    }
    if ((file.deleted && step.seq === file.lastStep && !step.deletes.length) || step.deletes.indexOf(file.index) >= 0) {
      fileState.deleted = true;
    }
    if (step.blind && step.blind.indexOf(file.index) >= 0) { fileState.blind = true; }
  }

  /**
   * The city after the step at `stepIndex` (-1: before the session). Pure and
   * idempotent: per-file touches, turns, visible height and heat category.
   */
  function stateAt(dataset, stepIndex, timeline) {
    var data = dataset?.normalized ? dataset : normalizeDataset(dataset);
    var line = timeline || buildTimeline(data);
    var last = Math.max(-1, Math.min(line.count - 1, Math.floor(toNumber(stepIndex, -1))));
    var files = (data?.files || []).map(function (file) { return initialFileState(file, line.writePlan); });
    var counts = { reads: 0, writes: 0, searches: 0, executes: 0, failures: 0 };
    for (var index = 0; index <= last; index += 1) {
      var step = line.steps[index];
      var key = TOUCH_KEY[step.kind];
      if (key) { counts[key] += 1; }
      if (step.failed) { counts.failures += 1; }
      for (var f = 0; f < step.files.length; f += 1) {
        applyStepToFile(files[step.files[f]], data.files[step.files[f]], step, line.writePlan);
      }
      for (var d = 0; d < step.deletes.length; d += 1) {
        if (step.files.indexOf(step.deletes[d]) < 0) { files[step.deletes[d]].deleted = true; }
      }
    }
    files.forEach(function (fileState) { fileState.heat = heatCategory(fileState); });
    return {
      stepIndex: last,
      current: last >= 0 ? line.steps[last] : null,
      files: files,
      counts: counts,
      footprint: files.filter(function (fileState) { return fileState.lastIndex >= 0; }).length
    };
  }

  /** A file the base analysis does not cover: its centre is in no district of its own folder chain. */
  function isOutsideFile(file, districts) {
    var dir = String(file?.dir || '');
    var chain = (districts || []).filter(function (district) {
      return district.path && (dir === district.path || dir.indexOf(district.path + '/') === 0);
    });
    return !chain.some(function (district) {
      return Math.abs(file.x - district.x) <= district.w / 2 + 1e-4 && Math.abs(file.z - district.z) <= district.d / 2 + 1e-4;
    });
  }

  /** Changes when the city must be rebuilt: file count, paths or footprints. */
  function layoutSignature(dataset) {
    var files = dataset?.files || [];
    var hash = 5381;
    var source = files.map(function (file) {
      return file.path + '|' + Math.round(file.x * 1000) + '|' + Math.round(file.z * 1000)
        + '|' + Math.round(file.w * 1000) + '|' + Math.round(file.d * 1000);
    }).join(';');
    for (var i = 0; i < source.length; i += 1) {
      hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    }
    return files.length + ':' + (hash >>> 0).toString(36);
  }

  /**
   * How a newer dataset revision lands. `index` is the current playhead.
   * Follow live at the end of a growing live session: keep the playhead on the
   * old last step and animate the new ones in order (animateFrom).
   */
  function planLiveUpdate(previous, next, index, options) {
    var nextCount = next?.steps?.length || 0;
    var previousCount = previous?.steps?.length || 0;
    var rebuild = !previous || layoutSignature(previous) !== layoutSignature(next);
    if (!previous) {
      return { rebuild: true, index: nextCount - 1, animateFrom: null };
    }
    var atEnd = index >= previousCount - 1;
    if (options?.followLive && next?.session?.live && atEnd && nextCount > previousCount) {
      return { rebuild: rebuild, index: previousCount - 1, animateFrom: previousCount };
    }
    if (options?.followLive && next?.session?.live && atEnd) {
      return { rebuild: rebuild, index: nextCount - 1, animateFrom: null };
    }
    return { rebuild: rebuild, index: Math.min(index, nextCount - 1), animateFrom: null };
  }

  function formatSigned(value) {
    var number = Math.round(Number(value) || 0);
    return number > 0 ? '+' + number : String(number);
  }

  /** The controller's metric rows (research.md section 4.5). ASCII only. */
  function metricsModel(dataset) {
    var m = dataset?.metrics || {};
    var count = function (value) { return String(Math.max(0, Math.round(Number(value) || 0))); };
    return [
      { label: 'Footprint', value: count(m.footprint) + ' files' },
      { label: 'Read / write / search / run', value: [m.reads, m.writes, m.searches, m.executes].map(count).join(' / ') },
      { label: 'Read/write ratio', value: m.readWriteRatio === null || m.readWriteRatio === undefined ? 'no writes' : Number(m.readWriteRatio).toFixed(2) },
      { label: 'Revisit rate', value: Math.round((Number(m.revisitRate) || 0) * 100) + '%' },
      { label: 'Blind writes', value: count(m.blindWrites) },
      { label: 'Unverified edits', value: count(m.unverifiedEdits) },
      { label: 'Unread dependents', value: Number(m.unreadDependents) < 0 ? 'unknown' : count(m.unreadDependents) },
      { label: 'Failures', value: count(m.failures) },
      { label: 'Delta code lines', value: m.delta ? formatSigned(m.delta.codeLines) : 'n/a' },
      { label: 'Delta complexity', value: m.delta ? formatSigned(m.delta.complexity) : 'n/a' }
    ];
  }

  /** "Turn 2: Edit tooltipsAndSelection.js" */
  function stepLine(timeline, index) {
    var step = timeline?.steps?.[index];
    if (!step) {
      return timeline?.count ? 'Before the first step' : 'No steps yet';
    }
    return 'Turn ' + (step.turn + 1) + ': ' + compact(step.title, 64) + (step.failed ? ' (failed)' : '');
  }

  /** Short verb for the floating label over the current building. */
  function stepVerb(step, file) {
    if (!step) { return ''; }
    if (step.kind === 'write') {
      var lines = step.added !== undefined || step.removed !== undefined
        ? ' +' + toNumber(step.added, 0) + ' -' + toNumber(step.removed, 0) : '';
      var created = file?.created && file.firstStep === step.seq;
      return (created ? 'Create' : (step.tool || 'Edit')) + lines;
    }
    if (step.kind === 'search') { return (step.tool || 'Search') + ': ' + step.files.length + ' match' + (step.files.length === 1 ? '' : 'es'); }
    if (step.kind === 'delegate') { return 'Delegate'; }
    if (step.kind === 'wait') {
      return step.status === 'failed' ? 'Permission rejected' : (step.status === 'running' ? 'Waiting for permission' : 'Permission granted');
    }
    if (step.deletes?.length) { return 'Delete'; }
    if (step.kind === 'execute') {
      return 'Run' + (step.exitCode !== undefined && step.exitCode !== null ? ' (exit ' + step.exitCode + ')' : '');
    }
    return step.tool || step.kind;
  }

  function relativeTime(timestamp, nowMs) {
    var seconds = Math.max(0, Math.round(((Number(nowMs) || Date.now()) - Number(timestamp || 0)) / 1000));
    if (!Number(timestamp)) { return ''; }
    if (seconds < 45) { return 'just now'; }
    if (seconds < 3600) { return Math.max(1, Math.round(seconds / 60)) + ' min ago'; }
    if (seconds < 86400) { return Math.round(seconds / 3600) + ' h ago'; }
    if (seconds < 86400 * 30) { return Math.round(seconds / 86400) + ' d ago'; }
    return new Date(Number(timestamp)).toISOString().slice(0, 10);
  }

  /** One page of the source picker: live sessions first, then newest first. */
  function sourcesPage(sources, page, size) {
    var list = (Array.isArray(sources) ? sources : []).slice().sort(function (a, b) {
      if (!!b.live !== !!a.live) { return b.live ? 1 : -1; }
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });
    var perPage = Math.max(1, Number(size) || SOURCE_PAGE_SIZE);
    var pages = Math.max(1, Math.ceil(list.length / perPage));
    var current = Math.max(0, Math.min(pages - 1, Math.floor(Number(page) || 0)));
    return { items: list.slice(current * perPage, (current + 1) * perPage), page: current, pages: pages, total: list.length };
  }
