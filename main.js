"use strict";

const { Plugin, PluginSettingTab, Setting, Modal, Menu, Notice, MarkdownView } = require("obsidian");

const WHEEL_STEP_PX = 10;
const MIN_SIZE_PX = 20;
const MAX_WIDTH_PX = 800;
const MAX_HEIGHT_PX = 200;
const CONTEXT_MENU_OFFSET = { x: 200, y: 4 };
const REPROCESS_DELAYS_MS = [0, 30, 80, 200];

/** 라이브 프리뷰·리딩뷰 공통: 이 루트 아래 `querySelectorAll("table")` 순서가 뷰와 포스트 프로세서에서 같아야 함 */
function getTableKeyScopeRoot(tableEl) {
  return (
    tableEl.closest(".markdown-source-view.mod-cm6") ||
    tableEl.closest(".markdown-source-view") ||
    tableEl.closest(".markdown-preview-view") ||
    tableEl.closest(".markdown-reading-view") ||
    tableEl.closest(".workspace-leaf-content") ||
    tableEl.ownerDocument?.body ||
    tableEl
  );
}

/**
 * 이전 버전 키 `path|I{n}`, `path|X{n}` → 현재 `path|G{n}` 폴백 조회용
 * @param {string} path
 * @param {string} canonicalKey getTableStorageKey 결과
 */
function legacyKeysForGlobalTable(path, canonicalKey) {
  const prefix = `${path}|G`;
  if (!canonicalKey.startsWith(prefix)) return [];
  const idx = canonicalKey.slice(prefix.length);
  if (!/^\d+$/.test(idx)) return [];
  return [`${path}|I${idx}`, `${path}|X${idx}`];
}

/**
 * 뷰(우클릭)와 마크다운 포스트 프로세서가 **동일한** 문자열을 쓰도록 단일화.
 * (예전: 뷰는 `|I`, 프로세서는 `|X` → 저장된 병합이 렌더에 안 붙는 문제)
 *
 * @param {string} path
 * @param {HTMLTableElement} tableEl
 * @param {{ view?: import("obsidian").MarkdownView, ctx?: import("obsidian").MarkdownPostProcessorContext, elRoot?: HTMLElement, fragmentIndex?: number }} opts
 */
function getTableStorageKey(path, tableEl, opts = {}) {
  const { view, ctx, elRoot, fragmentIndex = 0 } = opts;

  const getSecFor = (el) => {
    if (view?.previewMode?.getSectionInfo) {
      let sec = view.previewMode.getSectionInfo(el);
      let walk = el?.parentElement;
      for (let d = 0; d < 10 && sec?.lineStart == null && walk; d++) {
        sec = view.previewMode.getSectionInfo(walk);
        walk = walk.parentElement;
      }
      if (sec?.lineStart != null) return sec;
    }
    if (ctx?.getSectionInfo) {
      let sec = ctx.getSectionInfo(el);
      if (sec?.lineStart == null && elRoot) sec = ctx.getSectionInfo(elRoot);
      if (sec?.lineStart == null && el) {
        let walk = el.parentElement;
        for (let d = 0; d < 10 && sec?.lineStart == null && walk; d++) {
          sec = ctx.getSectionInfo(walk);
          walk = walk.parentElement;
        }
      }
      if (sec?.lineStart != null) return sec;
    }
    return null;
  };

  const sec = getSecFor(tableEl);
  const scope = getTableKeyScopeRoot(tableEl);
  const allInScope = [...scope.querySelectorAll("table")];

  if (sec?.lineStart != null) {
    const sameLine = allInScope.filter((t) => getSecFor(t)?.lineStart === sec.lineStart);
    if (sameLine.length <= 1) return `${path}|L${sec.lineStart}`;
    const n = sameLine.indexOf(tableEl);
    return `${path}|L${sec.lineStart}_n${n >= 0 ? n : fragmentIndex}`;
  }

  const g = allInScope.indexOf(tableEl);
  return `${path}|G${g >= 0 ? g : fragmentIndex}`;
}

function getMergesForKey(plugin, path, key) {
  const direct = plugin.settings.tableMerges?.[key];
  if (direct?.length) return direct;
  for (const alt of legacyKeysForGlobalTable(path, key)) {
    const m = plugin.settings.tableMerges?.[alt];
    if (m?.length) return m;
  }
  return [];
}

function getDimensionsForKey(plugin, path, key) {
  const direct = plugin.settings.tableDimensions?.[key];
  if (direct) return direct;
  for (const alt of legacyKeysForGlobalTable(path, key)) {
    const d = plugin.settings.tableDimensions?.[alt];
    if (d) return d;
  }
  return undefined;
}

function ensureTableDims(plugin, path, key) {
  if (!plugin.settings.tableDimensions) plugin.settings.tableDimensions = {};
  if (!plugin.settings.tableDimensions[key]) {
    const legacy = getDimensionsForKey(plugin, path, key);
    plugin.settings.tableDimensions[key] = legacy
      ? JSON.parse(JSON.stringify(legacy))
      : { colWidths: {}, rowHeights: {}, cellColors: {} };
  }
  return plugin.settings.tableDimensions[key];
}

function getViewContainingElement(app, el) {
  const leaves = app.workspace.getLeavesOfType("markdown");
  for (const leaf of leaves) {
    if (leaf.view?.containerEl?.contains(el)) return leaf.view;
  }
  return null;
}

function isMarkdownEditMode(view) {
  return view?.getMode?.() === "source";
}

function mergeRectsOverlap(a, b) {
  const r1b = a.r + (a.rowspan ?? 1);
  const c1b = a.c + (a.colspan ?? 1);
  const r2b = b.r + (b.rowspan ?? 1);
  const c2b = b.c + (b.colspan ?? 1);
  return !(r1b <= b.r || r2b <= a.r || c1b <= b.c || c2b <= a.c);
}

/** data-zl-r/c 없을 때(포스트프로세서 전)에도 행·열 인덱스 산출 */
function getCellRC(cell, tableEl) {
  if (cell?.dataset?.zlR != null && cell?.dataset?.zlC != null) {
    const r = parseInt(cell.dataset.zlR, 10);
    const c = parseInt(cell.dataset.zlC, 10);
    if (!Number.isNaN(r) && !Number.isNaN(c)) return { r, c };
  }
  const tr = cell?.closest?.("tr");
  if (!tr || !tableEl.contains(tr)) return null;
  const r = [...tableEl.querySelectorAll("tr")].indexOf(tr);
  const c = [...tr.querySelectorAll("td, th")].indexOf(cell);
  if (r < 0 || c < 0) return null;
  return { r, c };
}

/**
 * 선택된 칸 집합이 빈틈 없는 직사각형일 때만 병합 스펙 반환.
 * (바운딩 박스만 쓰면 L자·대각 선택 시 안 고른 칸까지 먹는 문제가 생김)
 * @param {Iterable<HTMLElement>} cellElements
 * @returns {{ r: number, c: number, rowspan: number, colspan: number } | null}
 */
function solidMergeRectFromCells(tableEl, cellElements) {
  const unique = [...new Set(cellElements)];
  if (unique.length < 2) return null;
  /** @type {Set<string>} */
  const keys = new Set();
  for (const cell of unique) {
    const rc = getCellRC(cell, tableEl);
    if (!rc) return null;
    keys.add(`${rc.r},${rc.c}`);
  }
  let minR = Infinity;
  let maxR = -1;
  let minC = Infinity;
  let maxC = -1;
  for (const k of keys) {
    const [r, c] = k.split(",").map(Number);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
  }
  const rowspan = maxR - minR + 1;
  const colspan = maxC - minC + 1;
  if (keys.size !== rowspan * colspan) return null;
  if (rowspan < 2 && colspan < 2) return null;
  return { r: minR, c: minC, rowspan, colspan };
}

/**
 * 옵시디언 다중 선택 칸만 수집 (래퍼의 active/highlight 등은 제외 — 엉뚱한 칸이 섞이는 주원인)
 */
function collectObsidianMarkedCells(tableEl) {
  const set = new Set();
  for (const el of tableEl.querySelectorAll("td, th")) {
    if (el.getAttribute("aria-selected") === "true") set.add(el);
  }
  for (const el of tableEl.querySelectorAll(
    "td.table-cell-selected, th.table-cell-selected, td.is-selected, th.is-selected"
  )) {
    set.add(el);
  }
  return set;
}

function getRectFromObsidianMarkedCells(tableEl) {
  return solidMergeRectFromCells(tableEl, collectObsidianMarkedCells(tableEl));
}

function finalizeMergeList(merges, newM, zr, zc) {
  const withoutAnchor = merges.filter((m) => !(m.r === zr && m.c === zc));
  const rest = withoutAnchor.filter((m) => !mergeRectsOverlap(m, newM));
  return [...rest, newM];
}

/** 저장 키 `경로|L10` 등에서 vault 경로만 분리 */
function tableKeyToVaultPath(key) {
  const pipe = key.indexOf("|");
  return pipe >= 0 ? key.slice(0, pipe) : "";
}

function refreshTableByKey(plugin, filePath, key) {
  if (!filePath) return;
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.containerEl || view.file?.path !== filePath) return;
  for (const table of view.containerEl.querySelectorAll("table")) {
    // WeakMap에 캐시된 키 우선 — 없으면 현 view로 재계산 (fallback)
    const tKey = plugin._tableKeyMap?.get(table) || getTableStorageKey(filePath, table, { view });
    if (tKey === key) {
      // 병합/해제 시: DOM 노드를 재사용해 되돌린 후 재적용 (innerHTML 교체 없음)
      revertMergesOnTable(table);
      processTable(plugin, table, filePath, key);
      break;
    }
  }
}

// ─── Undo / Redo ────────────────────────────────────────────────────────────

/**
 * 작업 전 현재 상태를 undo 스택에 저장.
 * merges 와 dimensions 모두 해당 key 에 대한 스냅샷을 보관한다.
 */
function pushUndoState(plugin, key) {
  if (!plugin._undoStack) plugin._undoStack = [];
  if (!plugin._redoStack) plugin._redoStack = [];
  plugin._undoStack.push({
    key,
    merges:     JSON.parse(JSON.stringify(plugin.settings.tableMerges?.[key]     ?? null)),
    dimensions: JSON.parse(JSON.stringify(plugin.settings.tableDimensions?.[key] ?? null)),
  });
  if (plugin._undoStack.length > 50) plugin._undoStack.shift();
  plugin._redoStack = []; // 새 작업이 생기면 redo 스택 초기화
}

/** undo/redo 엔트리를 실제 설정에 복원하고 DOM 을 갱신한다. */
async function applyUndoRedoEntry(plugin, entry) {
  const { key, merges, dimensions } = entry;
  if (!plugin.settings.tableMerges)     plugin.settings.tableMerges = {};
  if (!plugin.settings.tableDimensions) plugin.settings.tableDimensions = {};

  if (merges?.length) plugin.settings.tableMerges[key] = merges;
  else delete plugin.settings.tableMerges[key];

  if (dimensions) plugin.settings.tableDimensions[key] = dimensions;
  else delete plugin.settings.tableDimensions[key];

  await plugin.saveSettings();
  const fp = tableKeyToVaultPath(key);
  refreshTableByKey(plugin, fp, key);
  rerenderActiveMarkdownPreview(plugin);
  scheduleReprocessTablesInActiveMarkdownView(plugin, fp);
}

// ────────────────────────────────────────────────────────────────────────────

async function applyMergesList(plugin, key, list) {
  pushUndoState(plugin, key); // undo 스냅샷 저장
  if (!plugin.settings.tableMerges) plugin.settings.tableMerges = {};
  if (list?.length) plugin.settings.tableMerges[key] = list;
  else delete plugin.settings.tableMerges[key];
  await plugin.saveSettings();
  const fp = tableKeyToVaultPath(key);
  refreshTableByKey(plugin, fp, key);
  rerenderActiveMarkdownPreview(plugin);
  scheduleReprocessTablesInActiveMarkdownView(plugin, fp);
}

async function applyMergeSpec(plugin, key, merges, newM, zr, zc) {
  const next = finalizeMergeList(merges, newM, zr, zc);
  await applyMergesList(plugin, key, next);
}

/** rerender 직후 새 DOM에 병합·치수가 안 붙는 경우 대비 */
function reprocessTablesInActiveMarkdownView(plugin, filePath) {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.containerEl || view.file?.path !== filePath) return;
  const path = view.file.path;
  for (const table of view.containerEl.querySelectorAll("table")) {
    // 포스트 프로세서가 캐시한 키(L 기반) 우선
    const key = plugin._tableKeyMap?.get(table) || getTableStorageKey(path, table, { view });
    processTable(plugin, table, path, key);
  }
}

function scheduleReprocessTablesInActiveMarkdownView(plugin, filePath) {
  if (!filePath) return;
  for (const ms of REPROCESS_DELAYS_MS) {
    window.setTimeout(() => reprocessTablesInActiveMarkdownView(plugin, filePath), ms);
  }
}

function tagLogicalCellCoords(tableEl) {
  const rows = [...tableEl.querySelectorAll("tr")];
  rows.forEach((tr, r) => {
    [...tr.querySelectorAll("td, th")].forEach((cell, c) => {
      cell.dataset.zlR = String(r);
      cell.dataset.zlC = String(c);
    });
  });
}

function applyMergesToTable(tableEl, merges) {
  if (!merges?.length) return;
  const rows = [...tableEl.querySelectorAll("tr")];
  const grid = rows.map((tr) => [...tr.querySelectorAll("td, th")]);
  const sorted = merges
    .filter((m) => (m.rowspan ?? 1) > 1 || (m.colspan ?? 1) > 1)
    .sort((a, b) => (b.rowspan ?? 1) * (b.colspan ?? 1) - (a.rowspan ?? 1) * (a.colspan ?? 1));

  // 복원에 필요한 정보를 그룹 단위로 저장
  // DOM 노드를 삭제 대신 보존해 두므로 병합 해제 시 innerHTML 교체 없이 재삽입 가능
  tableEl._zlMergeGroups = [];

  for (const m of sorted) {
    const r = m.r;
    const c = m.c;
    const rowspan = m.rowspan ?? 1;
    const colspan = m.colspan ?? 1;
    const anchor = grid[r]?.[c];
    if (!anchor) continue;

    const anchorOriginalHTML = anchor.innerHTML; // 앵커 원본 내용 (내용 이동 전에 저장)
    const removed = [];

    const absorb = [];
    for (let dr = 0; dr < rowspan; dr++) {
      for (let dc = 0; dc < colspan; dc++) {
        if (dr === 0 && dc === 0) continue;
        const cell = grid[r + dr]?.[c + dc];
        if (cell) absorb.push(cell);
      }
    }

    for (const cell of absorb) {
      // 제거 전 복원 정보 저장
      removed.push({
        cell,
        tr: cell.parentElement,
        nextSib: cell.nextSibling,
        originalHTML: cell.innerHTML, // 내용 이동 전 저장
      });
      // contentMode "keepFirst": 앵커 내용만 유지, 나머지 버림 (Excel 기본 동작)
      // 그 외("concat" 또는 미지정): 내용 이어 붙이기
      if (m.contentMode !== "keepFirst" && cell.textContent?.trim()) {
        anchor.appendChild(document.createTextNode(" "));
        while (cell.firstChild) anchor.appendChild(cell.firstChild);
      }
      cell.remove();
    }

    anchor.rowSpan = rowspan;
    anchor.colSpan = colspan;

    tableEl._zlMergeGroups.push({ anchorEl: anchor, anchorOriginalHTML, removed });
  }
}

/**
 * applyMergesToTable 로 적용된 병합을 DOM 노드를 재사용해 원상복구.
 * innerHTML 을 교체하지 않으므로 Obsidian 편집기 상태(selection outline 등)가 보존됨.
 */
function revertMergesOnTable(tableEl) {
  tableEl._zlMergesApplied = false;
  if (!tableEl._zlMergeGroups?.length) {
    tableEl._zlMergeGroups = null;
    return;
  }
  // 적용 역순으로 되돌려야 nextSib 참조가 정합
  for (const { anchorEl, anchorOriginalHTML, removed } of [...tableEl._zlMergeGroups].reverse()) {
    anchorEl.rowSpan = 1;
    anchorEl.colSpan = 1;
    anchorEl.innerHTML = anchorOriginalHTML;
    // 제거된 셀도 역순으로 재삽입 (뒤쪽 셀부터 넣어야 nextSib 가 이미 DOM 에 있음)
    for (const { cell, tr, nextSib, originalHTML } of [...removed].reverse()) {
      cell.innerHTML = originalHTML;
      if (tr.isConnected) {
        if (nextSib && tr.contains(nextSib)) {
          tr.insertBefore(cell, nextSib);
        } else {
          tr.appendChild(cell);
        }
      }
    }
  }
  tableEl._zlMergeGroups = null;
}

function applyTableDimensions(tableEl, dims) {
  if (!dims) return;
  const colWidths = dims.colWidths || {};
  const rowHeights = dims.rowHeights || {};
  const cellColors = dims.cellColors || {};
  const rows = tableEl.querySelectorAll("tr");
  rows.forEach((tr, rowIdx) => {
    if (rowHeights[rowIdx] != null) {
      const h = Math.max(MIN_SIZE_PX, Number(rowHeights[rowIdx]) || MIN_SIZE_PX);
      tr.style.height = h + "px";
    }
    const cells = tr.querySelectorAll("td, th");
    cells.forEach((cell, colIdx) => {
      if (colWidths[colIdx] != null) {
        const w = Math.max(MIN_SIZE_PX, Number(colWidths[colIdx]) || MIN_SIZE_PX);
        cell.style.minWidth = w + "px";
        cell.style.width = w + "px";
      }
      const colorKey = rowIdx + "," + colIdx;
      if (cellColors[colorKey]) {
        cell.style.backgroundColor = cellColors[colorKey];
      } else {
        cell.style.removeProperty("background-color");
      }
    });
  });
}

function processTable(plugin, tableEl, path, key) {
  // 포스트 프로세서가 계산한 올바른 키(L 기반)를 캐시해두어
  // 편집 모드 컨텍스트 메뉴 등에서 동일 키 재사용 가능하게 함.
  if (plugin._tableKeyMap) plugin._tableKeyMap.set(tableEl, key);

  const trs = tableEl.querySelectorAll("tr");
  const rowCount = trs.length;
  let colCount = 0;
  if (trs[0]) colCount = trs[0].querySelectorAll("td, th").length;
  if (!plugin._tableShapeCache) plugin._tableShapeCache = {};
  plugin._tableShapeCache[key] = { rows: rowCount, cols: colCount };

  // 이미 병합이 적용된 DOM 이면 치수만 재적용하고 종료.
  // innerHTML 복원 없이 스킵해야 Obsidian 테이블 편집기 상태(selection outline 등)가 유지됨.
  if (tableEl._zlMergesApplied) {
    const dims = getDimensionsForKey(plugin, path, key);
    if (dims) applyTableDimensions(tableEl, dims);
    applyTableLayout(tableEl);
    return;
  }

  tagLogicalCellCoords(tableEl);
  const dims = getDimensionsForKey(plugin, path, key);
  if (dims) applyTableDimensions(tableEl, dims);
  const merges = getMergesForKey(plugin, path, key);
  if (merges?.length) {
    tableEl._zlMergesApplied = true;
    applyMergesToTable(tableEl, merges);
  }
  if (dims || merges?.length) applyTableLayout(tableEl);
}

/** 읽기/쓰기 모드 모두 동일한 테이블 레이아웃(width:max-content, overflow 스크롤)을 인라인으로 강제. */
function applyTableLayout(tableEl) {
  tableEl.style.tableLayout = "auto";
  tableEl.style.width = "max-content";
  tableEl.style.maxWidth = "none";
  const wrapper = tableEl.closest(".table-wrapper");
  if (wrapper) {
    wrapper.style.overflowX = "auto";
    wrapper.style.maxWidth = "100%";
  }
}

function rerenderActiveMarkdownPreview(plugin) {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (view?.previewMode?.rerender) view.previewMode.rerender(true);
}

function getLogicalCellIndices(cell, tableEl, tr, fallbackRow, fallbackCol) {
  if (cell.dataset.zlR != null && cell.dataset.zlC != null) {
    return { r: parseInt(cell.dataset.zlR, 10), c: parseInt(cell.dataset.zlC, 10) };
  }
  const rowIndex = Array.from(tableEl.querySelectorAll("tr")).indexOf(tr);
  const colIndex = Array.from(tr.querySelectorAll("td, th")).indexOf(cell);
  return {
    r: rowIndex >= 0 ? rowIndex : fallbackRow,
    c: colIndex >= 0 ? colIndex : fallbackCol,
  };
}

/**
 * 드래그 선택: Range가 스치는 모든 td를 모으면(intersectsNode) 안 고른 칸까지 들어가는 경우가 많음.
 * 시작 칸·끝 칸 두 모서리만으로 직사각형을 정함 (스프레드시트와 동일).
 * @returns {{ r: number, c: number, rowspan: number, colspan: number } | null}
 */
function getRectMergeFromTableRange(tableEl, range) {
  if (!range) return null;
  const cellFrom = (n) => {
    if (!n) return null;
    let el = n.nodeType === 1 ? n : n.parentElement;
    return el?.closest?.("td, th") ?? null;
  };
  const a = cellFrom(range.startContainer);
  const b = cellFrom(range.endContainer);
  if (!a || !b || a === b || !tableEl.contains(a) || !tableEl.contains(b)) return null;
  const rcA = getCellRC(a, tableEl);
  const rcB = getCellRC(b, tableEl);
  if (!rcA || !rcB) return null;
  const minR = Math.min(rcA.r, rcB.r);
  const maxR = Math.max(rcA.r, rcB.r);
  const minC = Math.min(rcA.c, rcB.c);
  const maxC = Math.max(rcA.c, rcB.c);
  const rowspan = maxR - minR + 1;
  const colspan = maxC - minC + 1;
  if (rowspan < 2 && colspan < 2) return null;
  return { r: minR, c: minC, rowspan, colspan };
}

/** Range(시작·끝 모서리) 우선, 그다음 aria 등으로 표시된 다중 선택 */
function getMergeRectForEditorMenu(plugin, tableEl) {
  const tryRange = (range) => {
    if (!range) return null;
    try {
      const ca = range.commonAncestorContainer;
      const wrap = ca.nodeType === 1 ? ca : ca.parentElement;
      if (!wrap || !tableEl.contains(wrap)) return null;
      return getRectMergeFromTableRange(tableEl, range);
    } catch (_) {
      return null;
    }
  };

  const sel = window.getSelection();
  if (sel?.rangeCount && !sel.isCollapsed) {
    const live = tryRange(sel.getRangeAt(0));
    if (live) return live;
  }

  if (plugin._mergeRangeSnapshot) {
    const snap = tryRange(plugin._mergeRangeSnapshot);
    if (snap) return snap;
  }

  return getRectFromObsidianMarkedCells(tableEl);
}

class CellResizeModal extends Modal {
  constructor(app, plugin, storageKey, colIndex, rowIndex, tableEl, currentDims) {
    super(app);
    this.plugin = plugin;
    this.storageKey = storageKey;
    this.colIndex = colIndex;
    this.rowIndex = rowIndex;
    this.tableEl = tableEl;
    this.currentDims = currentDims || { colWidths: {}, rowHeights: {} };
  }

  onOpen() {
    const key = this.storageKey;
    const pathPart = tableKeyToVaultPath(key);
    const dims = getDimensionsForKey(this.plugin, pathPart, key) || this.currentDims;
    const colW = dims.colWidths?.[this.colIndex] ?? "";
    const rowH = dims.rowHeights?.[this.rowIndex] ?? "";

    const cellColorKey = this.rowIndex + "," + this.colIndex;
    const cellColor = dims.cellColors?.[cellColorKey] ?? "";

    this.contentEl.createEl("h2", { text: "열/행 크기 · 셀 색" });
    this.contentEl.createEl("p", {
      text: "열 너비(px), 행 높이(px), 이 셀 배경색. 적용 버튼으로 저장.",
      cls: "setting-item-description",
    });

    let colInput, rowInput, colorInput;

    new Setting(this.contentEl)
      .setName("열 너비 (px)")
      .addText((t) => {
        colInput = t;
        t.setPlaceholder("예: 120").setValue(String(colW)).onChange(() => {});
      });

    new Setting(this.contentEl)
      .setName("행 높이 (px)")
      .addText((t) => {
        rowInput = t;
        t.setPlaceholder("예: 28").setValue(String(rowH)).onChange(() => {});
      });

    let colorCleared = false;
    new Setting(this.contentEl)
      .setName("이 셀 배경색")
      .setDesc("비우거나 '색 지우기' 후 적용하면 제거")
      .addColorPicker((cp) => {
        colorInput = cp;
        if (cellColor) cp.setValue(cellColor);
        cp.onChange(() => {
          colorCleared = false;
        });
      })
      .addButton((btn) => {
        btn.setButtonText("색 지우기").onClick(() => {
          colorCleared = true;
        });
      });

    new Setting(this.contentEl).addButton((btn) => {
      btn.setButtonText("적용").setCta().onClick(() => {
        const cw = parseInt(String(colInput.getValue()).trim(), 10);
        const rh = parseInt(String(rowInput.getValue()).trim(), 10);
        const color = colorCleared ? "" : String(colorInput?.getValue() ?? "").trim();
        pushUndoState(this.plugin, key); // undo 스냅샷 저장
        if (!this.plugin.settings.tableDimensions) this.plugin.settings.tableDimensions = {};
        if (!this.plugin.settings.tableDimensions[key]) {
          this.plugin.settings.tableDimensions[key] = { colWidths: {}, rowHeights: {}, cellColors: {} };
        }
        const d = this.plugin.settings.tableDimensions[key];
        if (!d.cellColors) d.cellColors = {};
        if (!isNaN(cw) && cw > 0) d.colWidths[this.colIndex] = cw;
        if (!isNaN(rh) && rh > 0) d.rowHeights[this.rowIndex] = rh;
        if (color) d.cellColors[cellColorKey] = color;
        else delete d.cellColors[cellColorKey];
        applyTableDimensions(this.tableEl, d);
        this.plugin.saveSettings();
        this.close();
      });
    });
  }
}

/**
 * 병합할 셀에 내용이 있을 때 처리 방식을 묻는 모달.
 * resolve 값: "keepFirst" | "concat" | null(취소)
 */
class MergeContentModal extends Modal {
  constructor(app, cellCount) {
    super(app);
    this.cellCount = cellCount;
    this.result = null;
  }
  onOpen() {
    this.contentEl.createEl("h3", { text: "병합할 셀에 내용이 있습니다" });
    this.contentEl.createEl("p", {
      text: `내용이 있는 셀 ${this.cellCount}개가 병합 영역에 포함됩니다. 어떻게 처리할까요?`,
      cls: "setting-item-description",
    });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });

    const keepBtn = row.createEl("button", { text: "첫 번째 칸만 유지" });
    keepBtn.addEventListener("click", () => { this.result = "keepFirst"; this.close(); });

    const concatBtn = row.createEl("button", { text: "내용 이어 붙이기" });
    concatBtn.addClass("mod-cta");
    concatBtn.addEventListener("click", () => { this.result = "concat"; this.close(); });

    const cancelBtn = row.createEl("button", { text: "취소" });
    cancelBtn.addEventListener("click", () => { this.result = null; this.close(); });
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** MergeContentModal을 Promise 로 감싸 async/await 에서 사용 */
function askMergeContentMode(app, cellCount) {
  return new Promise((resolve) => {
    const modal = new MergeContentModal(app, cellCount);
    const origClose = modal.onClose.bind(modal);
    modal.onClose = () => { origClose(); resolve(modal.result); };
    modal.open();
  });
}

/**
 * 현재 tableEl 이 속한 마크다운 표의 맨 아래에 빈 행을 추가한다.
 * 열 수는 첫 번째 행의 파이프(|) 개수로 추론.
 */
function insertTableRowAtBottom(plugin, view, tableEl) {
  const editor = view.editor;
  const key = plugin._tableKeyMap?.get(tableEl);

  // 표 시작 줄 파악: 캐시 키(L{n})에서 추출, 없으면 커서에서 역방향 탐색
  let startLine = -1;
  if (key) {
    const m = key.match(/\|L(\d+)$/);
    if (m) startLine = parseInt(m[1], 10);
  }
  if (startLine < 0) {
    startLine = editor.getCursor().line;
    while (startLine > 0 && editor.getLine(startLine - 1).trim().startsWith("|")) startLine--;
    if (!editor.getLine(startLine).trim().startsWith("|")) return;
  }

  // 표 마지막 줄 파악
  let endLine = startLine;
  const lineCount = editor.lineCount();
  for (let l = startLine; l < lineCount; l++) {
    if (editor.getLine(l).trim().startsWith("|")) endLine = l;
    else if (l > startLine) break;
  }

  // 첫 줄에서 열 수 추론 (파이프 개수 - 1)
  const firstLine = editor.getLine(startLine);
  const pipes = (firstLine.match(/\|/g) || []).length;
  const colCount = Math.max(1, pipes - 1);

  // 새 빈 행 삽입
  const newRow = "|" + " |".repeat(colCount);
  const endLineText = editor.getLine(endLine);
  editor.replaceRange("\n" + newRow, { line: endLine, ch: endLineText.length });

  // 새 행 첫 번째 칸으로 커서 이동
  editor.setCursor({ line: endLine + 1, ch: 2 });
  editor.focus();
}

/** 단축키 문자열 ("q", "shift+q", "ctrl+q" 등) 과 KeyboardEvent 가 일치하는지 확인 */
function matchHotkey(hk, e) {
  if (!hk) return false;
  const parts = hk.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (e.key.toLowerCase() !== key) return false;
  if (parts.includes("shift") !== e.shiftKey) return false;
  if (parts.includes("ctrl") !== e.ctrlKey) return false;
  if (parts.includes("alt") !== e.altKey) return false;
  if ((parts.includes("meta") || parts.includes("cmd")) !== e.metaKey) return false;
  return true;
}

module.exports = class ZeroLibraryPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.settings = {
      tableDimensions: {},
      tableMerges: {},
      hotkeys: {
        insertRow: "q",          // 표 맨 아래 행 추가
        resizeModifier: "ctrl",  // Ctrl+휠 열/행 크기 조절 수정키
      },
    };
    this.styleEl = null;
    this.wheelTooltipEl = null;
    this.wheelTooltipHideTimer = null;
    /** @type {Record<string, { rows: number, cols: number }>} */
    this._tableShapeCache = {};
    /** @type {{ x: number, y: number } | null} */
    this._lastContextMenuClient = null;
    /** @type {Range | null} contextmenu 캡처 시점 복제 (메뉴 열릴 때 selection은 이미 비는 경우 많음) */
    this._mergeRangeSnapshot = null;
    /**
     * 포스트 프로세서(ctx 있음)가 계산한 올바른 저장 키를 캐시.
     * 편집 모드 컨텍스트 메뉴는 ctx 없이 view만 있어 G{index} 키가 나오지만,
     * 여기서 L{lineStart} 키를 꺼내 씀으로써 읽기 모드·병합 해제와 동일 키 보장.
     * @type {WeakMap<HTMLTableElement, string>}
     */
    this._tableKeyMap = new WeakMap();
    /** @type {Array<{key:string, merges:any, dimensions:any}>} */
    this._undoStack = [];
    /** @type {Array<{key:string, merges:any, dimensions:any}>} */
    this._redoStack = [];
    /** 휠 리사이즈: key별 마지막 undo 푸시 시각 (디바운스용) */
    this._wheelUndoPushTimes = {};
  }

  async onload() {
    const loaded = await this.loadData();
    if (loaded && typeof loaded === "object") {
      if (loaded.tableDimensions) this.settings.tableDimensions = loaded.tableDimensions;
      if (loaded.tableMerges) this.settings.tableMerges = loaded.tableMerges;
      if (loaded.hotkeys) this.settings.hotkeys = { ...this.settings.hotkeys, ...loaded.hotkeys };
    }

    this.registerMarkdownPostProcessor(
      (el, ctx) => {
        try {
          const path = ctx?.sourcePath || "";
          const tables = el?.querySelectorAll?.("table");
          if (!tables?.length) return;
          tables.forEach((table, i) => {
            const key = getTableStorageKey(path, table, { ctx, elRoot: el, fragmentIndex: i });
            processTable(this, table, path, key);
          });
        } catch (err) {
          console.warn("0library table processor:", err);
        }
      },
      500
    );

    const snapshotMergeRangeFromSelection = (e) => {
      const sel = window.getSelection();
      if (sel?.rangeCount > 0 && !sel.isCollapsed) {
        try {
          const r = sel.getRangeAt(0).cloneRange();
          const t = e.target?.closest?.("table");
          if (t) {
            const ca = r.commonAncestorContainer;
            const wrap = ca.nodeType === 1 ? ca : ca.parentElement;
            if (wrap && t.contains(wrap)) this._mergeRangeSnapshot = r;
          }
        } catch (_) {
          /* ignore */
        }
      }
    };

    this.registerDomEvent(
      document,
      "mousedown",
      (e) => {
        if (e.button === 2) snapshotMergeRangeFromSelection(e);
        if (e.button === 0) this._mergeRangeSnapshot = null;
      },
      { capture: true }
    );

    /*
     * 기본 표 우클릭은 버블이 document까지 안 올 수 있음(stopPropagation) → 반드시 capture에서 처리.
     * 스냅샷 + 0Library 메뉴를 한 핸들러에서 처리.
     */
    this.registerDomEvent(
      document,
      "contextmenu",
      (e) => {
        this._lastContextMenuClient = { x: e.clientX, y: e.clientY };
        snapshotMergeRangeFromSelection(e);

        const cell = e.target?.closest?.("td, th");
        if (!cell) return;
        const tableEl = cell.closest("table");
        if (!tableEl) return;
        const view = getViewContainingElement(this.app, tableEl);
        if (!view?.file?.path || !isMarkdownEditMode(view)) return;
        if (!view.containerEl?.contains(tableEl)) return;

        const path = view.file.path;
        // 포스트 프로세서가 캐시한 키(L 기반) 우선 — 읽기 모드 연동·병합 해제 정합성 보장
        const key = this._tableKeyMap?.get(tableEl) || getTableStorageKey(path, tableEl, { view });
        const tr = cell.closest("tr");
        const domRow = Array.from(tableEl.querySelectorAll("tr")).indexOf(tr);
        const domCol = Array.from(tr.querySelectorAll("td, th")).indexOf(cell);
        const { r: zr, c: zc } = getLogicalCellIndices(cell, tableEl, tr, domRow, domCol);
        const currentDims = getDimensionsForKey(this, path, key);
        const merges = getMergesForKey(this, path, key);
        const anchorMerge = merges.find((m) => m.r === zr && m.c === zc);
        const canUnmerge =
          anchorMerge && ((anchorMerge.colspan ?? 1) > 1 || (anchorMerge.rowspan ?? 1) > 1);

        const px = e.clientX;
        const py = e.clientY;
        const plugin = this;
        /* 메뉴 클릭 시점에는 선택이 이미 사라지는 경우가 많아, 우클릭 직전 값을 고정 */
        const mergeRectSnapshot = getMergeRectForEditorMenu(this, tableEl);

        window.setTimeout(() => {
          if (!tableEl.isConnected || !view.containerEl?.contains(tableEl)) return;
          const menu = new Menu(plugin.app);
          menu.addItem((item) =>
            item
              .setTitle("열/행 크기 설정…")
              .setIcon("ruler")
              .onClick(() => {
                new CellResizeModal(plugin.app, plugin, key, zc, zr, tableEl, currentDims).open();
              })
          );
          menu.addSeparator();
          menu.addItem((item) =>
            item
              .setTitle("병합")
              .setIcon("git-merge")
              .onClick(async () => {
                let rectSel = mergeRectSnapshot;
                if (!rectSel || (rectSel.rowspan < 2 && rectSel.colspan < 2)) {
                  rectSel = getMergeRectForEditorMenu(plugin, tableEl);
                }
                if (!rectSel || (rectSel.rowspan < 2 && rectSel.colspan < 2)) {
                  new Notice("병합할 칸만 빈틈 없는 직사각형으로 선택한 뒤 다시 시도하세요.");
                  return;
                }

                // 앵커(첫 번째 칸) 외에 내용이 있는 셀 수를 확인
                // 이미 병합 적용된 경우 _zlMergeGroups 에서 원본 내용을 조회
                let contentCellCount = 0;
                for (let dr = 0; dr < rectSel.rowspan; dr++) {
                  for (let dc = 0; dc < rectSel.colspan; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const tr = rectSel.r + dr;
                    const tc = rectSel.c + dc;
                    // 현재 DOM에서 조회 (논리 좌표 data-zl-r/c 사용)
                    const cc = tableEl.querySelector(
                      `td[data-zl-r="${tr}"][data-zl-c="${tc}"], th[data-zl-r="${tr}"][data-zl-c="${tc}"]`
                    );
                    if (cc?.textContent?.trim()) {
                      contentCellCount++;
                    } else if (!cc && tableEl._zlMergeGroups) {
                      // 이미 제거된 셀은 _zlMergeGroups 의 originalHTML 에서 확인
                      for (const grp of tableEl._zlMergeGroups) {
                        const found = grp.removed.find(
                          (x) => parseInt(x.cell.dataset.zlR, 10) === tr && parseInt(x.cell.dataset.zlC, 10) === tc
                        );
                        if (found) {
                          const tmp = document.createElement("div");
                          tmp.innerHTML = found.originalHTML;
                          if (tmp.textContent?.trim()) contentCellCount++;
                          break;
                        }
                      }
                    }
                  }
                }

                // 내용 있는 셀이 있으면 처리 방식 선택 (없으면 바로 병합)
                let contentMode = "concat";
                if (contentCellCount > 0) {
                  contentMode = await askMergeContentMode(plugin.app, contentCellCount);
                  if (contentMode === null) return; // 취소
                }

                const mNow = getMergesForKey(plugin, path, key);
                await applyMergeSpec(plugin, key, mNow, { ...rectSel, contentMode }, rectSel.r, rectSel.c);
                plugin._mergeRangeSnapshot = null;
                window.getSelection()?.removeAllRanges?.();
                // 병합 후 Obsidian 선택 마커 초기화 (고정되는 문제 방지)
                for (const c of tableEl.querySelectorAll("[aria-selected='true']")) c.removeAttribute("aria-selected");
                for (const c of tableEl.querySelectorAll(".table-cell-selected, .is-selected")) {
                  c.classList.remove("table-cell-selected", "is-selected");
                }
                new Notice(`병합: ${rectSel.rowspan}×${rectSel.colspan}칸`);
              })
          );
          if (canUnmerge) {
            menu.addSeparator();
            menu.addItem((item) =>
              item
                .setTitle("셀 병합 해제")
                .setIcon("layout-grid")
                .onClick(async () => {
                  const mNow = getMergesForKey(plugin, path, key);
                  const next = mNow.filter((m) => !(m.r === zr && m.c === zc));
                  await applyMergesList(plugin, key, next);
                  new Notice("병합을 해제했습니다.");
                })
            );
          }
          menu.showAtPosition({ x: px + CONTEXT_MENU_OFFSET.x, y: py + CONTEXT_MENU_OFFSET.y });
        }, 0);
      },
      { capture: true }
    );

    this.wheelTooltipEl = document.createElement("div");
    this.wheelTooltipEl.className = "zerolibrary-wheel-tooltip";
    document.body.appendChild(this.wheelTooltipEl);

    this.registerDomEvent(
      document,
      "wheel",
      (e) => {
        // 수정키 설정: 'ctrl'은 Ctrl·Meta 모두 허용(크로스플랫폼), 나머지는 단독
        const resMod = this.settings.hotkeys?.resizeModifier || "ctrl";
        const resModActive =
          resMod === "ctrl" ? e.ctrlKey || e.metaKey :
          resMod === "meta" ? e.metaKey :
          resMod === "shift" ? e.shiftKey :
          resMod === "alt" ? e.altKey : e.ctrlKey || e.metaKey;
        if (!resModActive) return;
        const cell = e.target.closest("td, th");
        if (!cell || !cell.closest("table")) return;
        const tableEl = cell.closest("table");
        const view = getViewContainingElement(this.app, tableEl);
        if (!view?.file?.path) return;
        if (!isMarkdownEditMode(view)) return;
        const path = view.file.path;
        const key = this._tableKeyMap?.get(tableEl) || getTableStorageKey(path, tableEl, { view });
        const tr = cell.closest("tr");
        const domRow = Array.from(tableEl.querySelectorAll("tr")).indexOf(tr);
        const domCol = Array.from(tr.querySelectorAll("td, th")).indexOf(cell);
        const { r: rowIndex, c: colIndex } = getLogicalCellIndices(cell, tableEl, tr, domRow, domCol);
        // 휠 리사이즈 undo: 500ms 내 첫 이벤트에만 스냅샷 저장 (디바운스)
        const _now = Date.now();
        if (!this._wheelUndoPushTimes[key] || _now - this._wheelUndoPushTimes[key] > 500) {
          pushUndoState(this, key);
          this._wheelUndoPushTimes[key] = _now;
        }
        const dims = ensureTableDims(this, path, key);
        const delta = e.deltaY > 0 ? -WHEEL_STEP_PX : WHEEL_STEP_PX;
        let changed = false;
        let valuePx = 0;
        if (e.shiftKey) {
          const current = dims.rowHeights[rowIndex] ?? 24;
          const next = Math.min(MAX_HEIGHT_PX, Math.max(MIN_SIZE_PX, current + delta));
          dims.rowHeights[rowIndex] = next;
          valuePx = next;
          changed = true;
        } else {
          const current = dims.colWidths[colIndex] ?? 80;
          const next = Math.min(MAX_WIDTH_PX, Math.max(MIN_SIZE_PX, current + delta));
          dims.colWidths[colIndex] = next;
          valuePx = next;
          changed = true;
        }
        if (changed) {
          e.preventDefault();
          e.stopPropagation();
          applyTableDimensions(tableEl, dims);
          this.saveSettings();
          if (this.wheelTooltipEl) {
            this.wheelTooltipEl.textContent = e.shiftKey ? "행 " + valuePx + "px" : "열 " + valuePx + "px";
            const rect = cell.getBoundingClientRect();
            this.wheelTooltipEl.style.left = rect.left + rect.width / 2 + "px";
            this.wheelTooltipEl.style.top = rect.bottom + 6 + "px";
            this.wheelTooltipEl.classList.add("is-visible");
            if (this.wheelTooltipHideTimer) clearTimeout(this.wheelTooltipHideTimer);
            this.wheelTooltipHideTimer = setTimeout(() => {
              this.wheelTooltipEl?.classList.remove("is-visible");
              this.wheelTooltipHideTimer = null;
            }, 600);
          }
        }
      },
      { passive: false }
    );

    // 표 셀 안에서 설정된 키 → 맨 아래 빈 행 추가
    this.registerDomEvent(
      document,
      "keydown",
      (e) => {
        const hk = this.settings.hotkeys?.insertRow || "q";
        if (!matchHotkey(hk, e)) return;
        const cell = e.target?.closest?.("td, th");
        if (!cell) return;
        const tableEl = cell.closest("table");
        if (!tableEl) return;
        const view = getViewContainingElement(this.app, tableEl);
        if (!view?.file?.path || !isMarkdownEditMode(view)) return;
        e.preventDefault();
        e.stopPropagation();
        insertTableRowAtBottom(this, view, tableEl);
      },
      { capture: true }
    );

    // Ctrl+Z (실행 취소) / Ctrl+Shift+Z (다시 실행) — 표 셀 안에서만 플러그인 undo 인터셉트
    this.registerDomEvent(
      document,
      "keydown",
      async (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const isUndo = !e.shiftKey && e.key.toLowerCase() === "z";
        const isRedo = e.shiftKey  && e.key.toLowerCase() === "z";
        if (!isUndo && !isRedo) return;

        // 표 셀 안에 있을 때만 플러그인 undo/redo 인터셉트 (밖에선 Obsidian 기본 동작)
        const inTable = !!(e.target?.closest?.("td, th") || document.activeElement?.closest?.("td, th"));
        if (!inTable) return;

        if (isUndo && this._undoStack.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const entry = this._undoStack.pop();
          // 현재 상태를 redo 스택에 저장
          this._redoStack.push({
            key: entry.key,
            merges:     JSON.parse(JSON.stringify(this.settings.tableMerges?.[entry.key]     ?? null)),
            dimensions: JSON.parse(JSON.stringify(this.settings.tableDimensions?.[entry.key] ?? null)),
          });
          await applyUndoRedoEntry(this, entry);
          new Notice("실행 취소");
        } else if (isRedo && this._redoStack.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const entry = this._redoStack.pop();
          // 현재 상태를 undo 스택에 저장
          this._undoStack.push({
            key: entry.key,
            merges:     JSON.parse(JSON.stringify(this.settings.tableMerges?.[entry.key]     ?? null)),
            dimensions: JSON.parse(JSON.stringify(this.settings.tableDimensions?.[entry.key] ?? null)),
          });
          await applyUndoRedoEntry(this, entry);
          new Notice("다시 실행");
        }
      },
      { capture: true }
    );

    // 노트를 나갔다 돌아올 때 병합·치수 재적용
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view?.getViewType?.() !== "markdown") return;
        const fp = leaf.view?.file?.path;
        if (fp) scheduleReprocessTablesInActiveMarkdownView(this, fp);
      })
    );

    this.addSettingTab(
      new (class extends PluginSettingTab {
        constructor(app, plugin) {
          super(app, plugin);
          this.plugin = plugin;
        }
        display() {
          const { containerEl } = this;
          containerEl.empty();
          containerEl.createEl("h2", { text: "0Library" });

          containerEl.createEl("h3", { text: "단축키" });

          new Setting(containerEl)
            .setName("표 맨 아래 행 추가")
            .setDesc(
              "표 셀 안에서 이 키를 누르면 맨 아래에 빈 행이 추가됩니다.\n" +
              "수정키 포함 가능: q, shift+q, ctrl+q, alt+q"
            )
            .addText((t) => {
              t.setPlaceholder("예: q")
                .setValue(this.plugin.settings.hotkeys?.insertRow ?? "q")
                .onChange(async (v) => {
                  if (!this.plugin.settings.hotkeys) this.plugin.settings.hotkeys = {};
                  this.plugin.settings.hotkeys.insertRow = v.trim().toLowerCase() || "q";
                  await this.plugin.saveSettings();
                });
            });

          new Setting(containerEl)
            .setName("열/행 크기 조절 수정키")
            .setDesc("이 수정키를 누른 채 휠을 돌리면 열 너비(기본) 또는 행 높이(Shift 병행)가 조절됩니다.")
            .addDropdown((dd) => {
              dd.addOption("ctrl", "Ctrl (또는 Cmd)")
                .addOption("shift", "Shift")
                .addOption("alt", "Alt")
                .addOption("meta", "Meta / Cmd 단독")
                .setValue(this.plugin.settings.hotkeys?.resizeModifier ?? "ctrl")
                .onChange(async (v) => {
                  if (!this.plugin.settings.hotkeys) this.plugin.settings.hotkeys = {};
                  this.plugin.settings.hotkeys.resizeModifier = v;
                  await this.plugin.saveSettings();
                });
            });

          containerEl.createEl("h3", { text: "우클릭 메뉴 (편집 모드)" });
          containerEl.createEl("p", {
            text: "표 셀 우클릭 → 열/행 크기 설정, 셀 병합 / 병합 해제.",
            cls: "setting-item-description",
          });
        }
      })(this.app, this)
    );

    this.addRibbonIcon("ruler", "0Library: 편집 모드 표 우클릭 메뉴", () => {});
  }

  onunload() {
    if (this.styleEl && this.styleEl.parentNode) this.styleEl.remove();
    if (this.wheelTooltipHideTimer) clearTimeout(this.wheelTooltipHideTimer);
    if (this.wheelTooltipEl?.parentNode) this.wheelTooltipEl.remove();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};
