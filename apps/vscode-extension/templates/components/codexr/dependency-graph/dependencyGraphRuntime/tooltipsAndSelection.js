// == dependencyGraphRuntime.js | tooltipsAndSelection (assembled per manifest.json; see COMPONENTS.md) ==
      selectionKey: function (selection) {
        return String(selection.type) + ':' + String(selection.id);
      },
      recordFor: function (selection) {
        return selection.type === 'node' ? this.nodes[selection.id] : this.edgeRecords[selection.id];
      },
      selectionAnchor: function (selection, record) {
        record = record || this.recordFor(selection);
        if (!record) { return null; }
        var point = selection.type === 'node' ? record.el.object3D.position : record.midpoint;
        return { x: Number(point.x || 0), y: Number(point.y || 0), z: Number(point.z || 0) };
      },
      isPinned: function (selection) {
        return (this.pinnedSelections || []).some(function (pinned) {
          return pinned.type === selection.type && pinned.id === selection.id;
        });
      },
      hasActiveSelection: function () {
        return (this.pinnedSelections || []).length > 0 || !!this.hoveredSelection;
      },
      // The last-touched selection, used by the single-focus visuals (flow tint,
      // status readout) that stay meaningful with just one representative.
      primarySelection: function () {
        if (this.hoveredSelection) { return this.hoveredSelection; }
        var pinned = this.pinnedSelections || [];
        return pinned.length ? pinned[pinned.length - 1] : null;
      },
      // Every legend currently on screen: all pins plus a distinct hover.
      activeSelections: function () {
        var list = (this.pinnedSelections || []).slice();
        if (this.hoveredSelection && !this.isPinned(this.hoveredSelection)) {
          list.push(this.hoveredSelection);
        }
        return list;
      },
      // All legend cards live under one board entity; the board yaw-billboards
      // toward the user as a rigid group, so cards follow the viewer without
      // ever rotating into each other (their relative layout never changes).
      ensureLegendBoard: function () {
        if (this.legendBoard?.isConnected) { return this.legendBoard; }
        // Registered with the screens' placement registry (PANELS-5): a
        // placed screen never lands on the card stack.
        this.legendBoard = entity('a-entity', {
          class: 'codexr-legend-board',
          'data-codexr-panel-obstacle': 'dependency-legend-board'
        });
        this.legendBoardYaw = null;
        this.el.appendChild(this.legendBoard);
        return this.legendBoard;
      },
      // Node/edge anchors are expressed in the graph's space; leader lines live
      // inside the (rotated) board, so anchors must be converted per update.
      anchorInBoardSpace: function (anchor) {
        if (!anchor || !root.THREE || !this.legendBoard?.object3D) { return anchor; }
        var vec = new root.THREE.Vector3(anchor.x, anchor.y, anchor.z);
        this.el.object3D.updateWorldMatrix(true, false);
        this.el.object3D.localToWorld(vec);
        this.legendBoard.object3D.updateWorldMatrix(true, false);
        this.legendBoard.object3D.worldToLocal(vec);
        return { x: vec.x, y: vec.y, z: vec.z };
      },
      updateLegendBoard: function () {
        var board = this.legendBoard;
        if (!board?.object3D || !this.hasActiveSelection()) { return; }
        root.CodeXRCommonRuntime?.faceCameraYaw?.(board, this.el.sceneEl);
        var yaw = board.object3D.rotation.y;
        if (this.legendBoardYaw == null || Math.abs(yaw - this.legendBoardYaw) > .004) {
          this.legendBoardYaw = yaw;
          this.positionPinnedTooltip();
        }
      },
      acquireLegendCard: function (key) {
        this.legendCards = this.legendCards || {};
        if (this.legendCards[key]) { return this.legendCards[key]; }
        var card = root.CodeXRCommonRuntime?.createTooltip
          ? root.CodeXRCommonRuntime.createTooltip({ accentColor: '#38bdf8', width: LEGEND_SLOT.cardWidth })
          : null;
        if (!card) { return null; }
        this.ensureLegendBoard().appendChild(card.root);
        this.legendCards[key] = card;
        return card;
      },
      releaseLegendCard: function (key) {
        this.legendCards = this.legendCards || {};
        var card = this.legendCards[key];
        if (!card) { return; }
        if (card.action?.parentNode) { card.action.parentNode.removeChild(card.action); }
        if (card.editorAction?.parentNode) { card.editorAction.parentNode.removeChild(card.editorAction); }
        if (card.closeButton?.parentNode) { card.closeButton.parentNode.removeChild(card.closeButton); }
        root.CodeXRCommonRuntime?.hideTooltip?.(card);
        if (card.connectorRoot?.parentNode) { card.connectorRoot.parentNode.removeChild(card.connectorRoot); }
        if (card.root?.parentNode) { card.root.parentNode.removeChild(card.root); }
        delete this.legendCards[key];
      },
      renderLegendCard: function (card, selection, slotPosition) {
        var record = this.recordFor(selection);
        if (!card || !record || !root.CodeXRCommonRuntime?.updateTooltip) { return; }
        var detail = selection.type === 'node'
          ? nodeDetailModel(record.data)
          : edgeDetailModel(record.data, this.nodes);
        var anchor = this.selectionAnchor(selection, record);
        var canNavigate = selection.type === 'node'
          && (record.data.kind === 'group' || record.data.kind === 'file' || record.data.syntheticExternal)
          && record.data.syntheticKind !== 'budget-rest';
        // #16: a file or symbol opens in the host's editor. The Code-XR IDE
        // embeds the scene beside its editor and exposes CodeXRHostBridge;
        // anywhere else (VS Code's browser tab) a page on this machine asks
        // the analysis server, which opens the file in VS Code or the IDE. A
        // guest through a tunnel or the LAN gets no button (and the server
        // would refuse it anyway).
        var hostBridge = root.CodeXRHostBridge;
        var canOpenInEditor = typeof hostBridge?.openInEditor === 'function'
          || (typeof client()?.sendMessage === 'function' && isLocalPage());
        var editorTarget = selection.type === 'node'
          && canOpenInEditor
          && !record.data.external && !record.data.syntheticExternal && !record.data.syntheticKind
          && (record.data.kind === 'file' || record.data.kind === 'symbol')
          && record.data.relativePath
          ? { path: String(record.data.relativePath), line: Number(record.data.lineStart) > 0 ? Number(record.data.lineStart) : undefined }
          : null;
        if (card.action?.parentNode) { card.action.parentNode.removeChild(card.action); }
        card.action = null;
        if (card.editorAction?.parentNode) { card.editorAction.parentNode.removeChild(card.editorAction); }
        card.editorAction = null;
        if (card.closeButton?.parentNode) { card.closeButton.parentNode.removeChild(card.closeButton); }
        card.closeButton = null;
        root.CodeXRCommonRuntime.updateTooltip(card, detail, slotPosition, {
          width: LEGEND_SLOT.cardWidth,
          columns: 2,
          footerReserve: canNavigate || editorTarget ? .3 : 0,
          titleLength: 28,
          connectorTarget: this.anchorInBoardSpace(anchor),
          connectorColor: detail.accentColor || '#38bdf8'
        });
        if (canNavigate) {
          var data = record.data;
          var actionLabel = data.syntheticExternal ? 'Show external'
            : data.syntheticKind === 'parent' ? 'Go to parent'
            : data.syntheticKind === 'directory' ? 'Open folder'
            : data.kind === 'file' ? 'Open file' : 'Open';
          card.action = button(
            actionLabel,
            (editorTarget ? '-0.6 ' : '0 ') + (-(card.height / 2) + .17) + ' 0.02',
            editorTarget ? 1.1 : data.syntheticExternal ? 1.9 : 1.5,
            function (event) {
              event.stopPropagation?.();
              if (data.syntheticExternal) { publishState({ showExternal: true }); }
              else if (data.kind === 'file') { openFile(data.relativePath || data.label); }
              else { openDirectory(data.navigationPath || data.relativePath || ''); }
            },
            data.syntheticExternal ? '#c2410c' : '#7c3aed'
          );
          card.root.appendChild(card.action);
        }
        if (editorTarget) {
          card.editorAction = button(
            'Open in editor',
            (canNavigate ? '0.6 ' : '0 ') + (-(card.height / 2) + .17) + ' 0.02',
            canNavigate ? 1.1 : 1.5,
            function (event) {
              event.stopPropagation?.();
              if (typeof hostBridge?.openInEditor === 'function') { hostBridge.openInEditor(editorTarget); }
              else { client()?.sendMessage?.('open-in-editor', editorTarget); }
            },
            '#0f766e'
          );
          card.editorAction.setAttribute('data-codexr-role', 'legend-open-in-editor');
          card.root.appendChild(card.editorAction);
        }
        if (this.isPinned(selection)) {
          // A pinned card closes on its own (PANELS-7): before, the only
          // way out was finding its node again or the global clear.
          var self = this;
          var pinnedSelection = { type: selection.type, id: selection.id };
          card.closeButton = button(
            'X',
            // Just outside the top-right corner, inside the grid gap (0.28
            // wide < gapX 0.34): it never covers the title or a neighbour.
            (LEGEND_SLOT.cardWidth / 2 + .17) + ' ' + (card.height / 2 - .14) + ' 0.03',
            .28,
            function (event) {
              event.stopPropagation?.();
              if (self.isPinned(pinnedSelection)) { self.togglePinnedSelection(pinnedSelection); }
            },
            '#475569'
          );
          card.closeButton.setAttribute('height', .28);
          card.closeButton.setAttribute('data-codexr-role', 'legend-close');
          card.root.appendChild(card.closeButton);
        }
      },
      // Re-place every visible legend into a non-overlapping grid slot above the
      // graph, drop cards whose selection is gone, and refresh the shared visuals.
      relayoutLegends: function () {
        this.legendCards = this.legendCards || {};
        var active = this.activeSelections();
        var wanted = {};
        active.forEach(function (selection) { wanted[this.selectionKey(selection)] = true; }, this);
        Object.keys(this.legendCards).forEach(function (key) {
          if (!wanted[key]) { this.releaseLegendCard(key); }
        }, this);
        if (active.length) {
          // The board carries the grid origin; slots are board-relative so the
          // yaw billboard rotates the whole arrangement rigidly.
          var board = this.ensureLegendBoard();
          board.setAttribute('position', '0 ' + (this.graphTopY + LEGEND_SLOT.originYOffset) + ' ' + LEGEND_SLOT.z);
          this.legendBoardYaw = null;
        }
        active.forEach(function (selection, index) {
          if (!this.recordFor(selection)) { return; }
          var card = this.acquireLegendCard(this.selectionKey(selection));
          if (!card) { return; }
          var slot = root.CodeXRCommonRuntime.legendSlotPosition(index, active.length, {
            perRow: LEGEND_SLOT.perRow,
            maxRows: LEGEND_SLOT.maxRows,
            cardWidth: LEGEND_SLOT.cardWidth,
            cardHeight: LEGEND_SLOT.cardHeight,
            gapX: LEGEND_SLOT.gapX,
            gapY: LEGEND_SLOT.gapY,
            originY: 0,
            z: 0
          });
          this.renderLegendCard(card, selection, slot);
        }, this);
        this.applyHighlightUnion();
        this.setScopeLabelDocked(active.length > 0);
      },
      // Called from the transition tick and on board rotation: keep each card's
      // leader line on its node/edge (slots are fixed; anchors move under the
      // transition, and the board-space anchor changes as the board turns).
      positionPinnedTooltip: function () {
        if (!root.THREE || !root.CodeXRCommonRuntime?.updateTooltipConnector) { return; }
        this.activeSelections().forEach(function (selection) {
          var card = (this.legendCards || {})[this.selectionKey(selection)];
          if (!card || !card.root?.getAttribute('visible')) { return; }
          var anchor = this.selectionAnchor(selection);
          if (!anchor) { return; }
          var pos = card.root.getAttribute('position') || { x: 0, y: 0, z: 0 };
          root.CodeXRCommonRuntime.updateTooltipConnector(card, {
            x: Number(pos.x || 0), y: Number(pos.y || 0), z: Number(pos.z || 0)
          }, this.anchorInBoardSpace(anchor), { connectorColor: card.accentColor || '#38bdf8' });
        }, this);
      },
      showTransientSelection: function (selection) {
        if (this.isPinned(selection)) { return; }
        this.hoveredSelection = selection;
        this.relayoutLegends();
      },
      hideTransientSelection: function (selection) {
        if (this.hoveredSelection?.type !== selection.type
            || this.hoveredSelection?.id !== selection.id) { return; }
        this.hoveredSelection = null;
        this.relayoutLegends();
      },
      togglePinnedSelection: function (selection) {
        this.pinnedSelections = this.pinnedSelections || [];
        if (this.isPinned(selection)) {
          this.pinnedSelections = this.pinnedSelections.filter(function (pinned) {
            return !(pinned.type === selection.type && pinned.id === selection.id);
          });
        } else {
          this.pinnedSelections.push({ type: selection.type, id: selection.id });
          if (this.pinnedSelections.length > MAX_PINNED_LEGENDS) {
            this.releaseLegendCard(this.selectionKey(this.pinnedSelections.shift()));
          }
        }
        if (this.hoveredSelection
            && this.hoveredSelection.type === selection.type
            && this.hoveredSelection.id === selection.id) {
          this.hoveredSelection = null;
        }
        this.relayoutLegends();
      },
      restorePinnedSelection: function () {
        this.relayoutLegends();
      },
      // Drop selections whose node/edge no longer exists (after a re-layout).
      prunePinnedSelections: function () {
        var self = this;
        this.pinnedSelections = (this.pinnedSelections || []).filter(function (selection) {
          if (self.recordFor(selection)) { return true; }
          self.releaseLegendCard(self.selectionKey(selection));
          return false;
        });
        if (this.hoveredSelection && !this.recordFor(this.hoveredSelection)) {
          this.releaseLegendCard(this.selectionKey(this.hoveredSelection));
          this.hoveredSelection = null;
        }
      },
      hideAllLegends: function () {
        this.pinnedSelections = [];
        this.hoveredSelection = null;
        Object.keys(this.legendCards || {}).forEach(function (key) { this.releaseLegendCard(key); }, this);
        this.clearHighlight();
        this.setScopeLabelDocked(false);
      },
      // Highlight the union of every active selection's neighbourhood (so pinning
      // several nodes keeps all their relations lit, not just the last one).
      applyHighlightUnion: function () {
        var active = this.activeSelections();
        if (!active.length) { this.clearHighlight(); return; }
        var related = new Set();
        var edges = this.dataset?.edges || [];
        active.forEach(function (selection) {
          if (selection.type === 'node') {
            related.add(selection.id);
            edges.forEach(function (edge) {
              if (edge.source === selection.id) { related.add(edge.target); }
              if (edge.target === selection.id) { related.add(edge.source); }
            });
          } else {
            var edge = this.edgeRecords[selection.id]?.data;
            if (edge) { related.add(edge.source); related.add(edge.target); }
          }
        }, this);
        Object.keys(this.nodes).forEach(function (nodeId) {
          this.nodes[nodeId].highlightTarget = related.has(nodeId) ? 1 : .18;
          this.nodes[nodeId].highlightColor = related.has(nodeId);
        }, this);
        var self = this;
        Object.keys(this.edgeRecords).forEach(function (edgeId) {
          self.edgeRecords[edgeId].highlighted = self.isEdgeActive(self.edgeRecords[edgeId].data);
        });
        this.selectionStartedAt = root.performance?.now?.() || Date.now();
        this.syncSelectionHalos(active
          .filter(function (selection) { return selection.type === 'node'; })
          .map(function (selection) { return selection.id; }));
        this.refreshEdgeColors(true);
        this.rebuildFocusEdges();
        this.updateFlowVisibility();
        var primary = this.primarySelection();
        if (primary) {
          var detail = primary.type === 'node'
            ? nodeDetailModel(this.nodes[primary.id]?.data)
            : edgeDetailModel(this.edgeRecords[primary.id]?.data, this.nodes);
          if (detail) {
            setStatus([detail.title, detail.subtitle, detail.primary, detail.secondary].join(' | '), false);
          }
        }
      },
      clearHighlight: function () {
        Object.keys(this.nodes).forEach(function (nodeId) {
          this.nodes[nodeId].highlightTarget = 1;
          this.nodes[nodeId].highlightColor = false;
        }, this);
        Object.keys(this.edgeRecords).forEach(function (edgeId) {
          this.edgeRecords[edgeId].highlighted = false;
        }, this);
        this.disposeSelectionHalos();
        this.refreshEdgeColors(false);
        this.disposeFocusEdges();
        this.updateFlowVisibility();
        setStatus('', false);
      },
      selectNode: function (id) {
        this.togglePinnedSelection({ type: 'node', id: id });
      },
      // #178: "Reveal in XR scene" from the editor (analysis-table sceneReveal.js):
      // pins the card of the file's node (never unpins it) and returns its
      // entity for the marker, or null when the graph does not show the file.
      // A file inside a folder drawn as one card reveals that card (the
      // deepest folder that holds it).
      revealFile: function (relativePath) {
        var nodes = this.nodes || {};
        var target = normalizeRelativePath(relativePath);
        var id = null;
        var folderDepth = -1;
        Object.keys(nodes).forEach(function (key) {
          var data = nodes[key]?.data;
          if (!data || data.external) { return; }
          var nodePath = normalizeRelativePath(data.relativePath);
          if (data.kind === 'file' && nodePath === target) {
            id = key;
            folderDepth = Infinity;
          } else if (data.kind === 'group' && nodePath && target.indexOf(nodePath + '/') === 0 && nodePath.length > folderDepth) {
            id = key;
            folderDepth = nodePath.length;
          }
        });
        if (!id) { return null; }
        if (!this.isPinned({ type: 'node', id: id })) { this.togglePinnedSelection({ type: 'node', id: id }); }
        return nodes[id].el || null;
      },
      getDebugSnapshot: function () {
        var visibleRecords = Object.values(this.edgeRecords || {}).filter(function (record) {
          return !record.remove && record.batch;
        });
        var activeSelection = this.primarySelection();
        return {
          layout: this.view?.layout || null,
          pinnedCount: (this.pinnedSelections || []).length,
          scope: this.view?.scope ? Object.assign({}, this.view.scope) : null,
          mapping: Object.assign({}, this.view?.mapping || {}),
          edgeEncoding: this.view?.edgeEncoding || 'relation-type',
          datasetNodes: Number(state.dataset?.nodes?.length || this.dataset?.nodes?.length || 0),
          datasetEdges: Number(state.dataset?.edges?.length || this.dataset?.edges?.length || 0),
          visibleNodes: Object.keys(this.nodes || {}).length,
          visibleEdges: visibleRecords.length,
          arrowCount: visibleRecords.filter(function (record) {
            return this.visualBudget?.arrowsForAll || this.focusEdgeIds.has(record.data.id);
          }, this).length,
          animatedFlowCount: Number(this.lastFlowCount || 0),
          focusEdgeCount: Number(this.focusEdgeObjects?.length || 0),
          selection: activeSelection ? Object.assign({}, activeSelection) : null,
          transitionActive: !!this.transition,
          transitionProgress: this.el.getAttribute('data-codexr-transition-progress') || null,
          layoutGeneration: Number(this.layoutGeneration || 0),
          detailOverride: this.visualBudget?.override || 'auto',
          densityProfile: this.visualBudget?.profile || 'unknown',
          effectiveProfile: this.visualBudget?.effectiveProfile || 'unknown'
        };
      }
    });
  }

  function numericGradient(value, maxValue) {
    var ratio = Math.max(0, Math.min(1, Number(value || 0) / Math.max(1, Number(maxValue || 1))));
    var red = Math.round(38 + (217 * ratio));
    var green = Math.round(198 - (110 * ratio));
    var blue = Math.round(218 - (174 * ratio));
    return '#' + [red, green, blue].map(function (part) {
      return part.toString(16).padStart(2, '0');
    }).join('');
  }

  function renderGraph() {
    if (!state.active || !state.dataset || !state.snapshot || state.snapshot.status !== 'ready') { return; }
    parkOriginal();
    if (refs.graph && !refs.graph.isConnected) {
      refs.graph = null;
    }
    if (!refs.graph) {
      refs.graph = entity('a-entity', {
        id: 'codexrDependencyGraph',
        position: '0 1.02 -18',
        'data-codexr-analysis-root': 'true',
        'data-codexr-analysis-mode': 'dependency-graph',
        'codexr-dependency-graph': ''
      });
      refs.graph.addEventListener('componentinitialized', function (event) {
        if (event?.detail?.name !== COMPONENT) { return; }
        renderCurrentGraphIfReady();
      });
      if (root.CodeXRAnalysisSurfaceRuntime?.mountRoot) {
        root.CodeXRAnalysisSurfaceRuntime.mountRoot('dependency-graph', refs.graph);
      } else {
        doc()?.querySelector('a-scene')?.appendChild(refs.graph);
      }
    } else {
      root.CodeXRAnalysisSurfaceRuntime?.mountRoot?.('dependency-graph', refs.graph);
    }
    var graph = filteredDataset();
    renderGraphWhenReady(graph, state.snapshot, state.viewGeneration, 0);
  }
