/**
 * Zotero Reading Mode – bootstrap.js
 *
 * A small, reworked reading mode with minimal mutations and robust tab
 * switching support. This version avoids stale visibility overrides and keeps
 * only the active reader visible during fullscreen activation.
 */

"use strict";

var _readingModeInstance = null;

function startup(data, reason) { // eslint-disable-line no-unused-vars
  const _doStartup = () => {
    try {
      _readingModeInstance = new ReadingMode(data.rootURI);
      _readingModeInstance.init();
    } catch (e) {
      dump("ReadingMode startup error: " + e + "\n");
    }
  };

  if (typeof Zotero !== "undefined" && Zotero.initialized) {
    _doStartup();
  } else if (typeof Zotero !== "undefined") {
    Zotero.initializationPromise.then(_doStartup).catch((e) => dump("ReadingMode init error: " + e + "\n"));
  } else {
    Services.tm.dispatchToMainThread(_doStartup);
  }
}

function shutdown(data, reason) { // eslint-disable-line no-unused-vars
  if (_readingModeInstance) {
    try {
      _readingModeInstance.destroy();
    } catch (e) {
      dump("ReadingMode shutdown error: " + e + "\n");
    }
    _readingModeInstance = null;
  }
}

function install(data, reason) {} // eslint-disable-line no-unused-vars
function uninstall(data, reason) {} // eslint-disable-line no-unused-vars

class ReadingMode {
  constructor(rootURI) {
    this._rootURI = rootURI;
    this._mainWindow = null;
    this._isActive = false;
    this._styleElement = null;
    this._floatingExitBtn = null;
    this._tabSyncTimer = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onFullscreenChange = this._onFullscreenChange.bind(this);
  }

  init() {
    this._mainWindow = this._getMainWindow();
    if (!this._mainWindow) {
      dump("ReadingMode: no main window available\n");
      return;
    }

    this._injectStyles();
    this._registerEventListeners();
    this._injectReaderToolbarButtons();
  }

  destroy() {
    if (this._isActive) {
      this._deactivate(true);
    }

    this._unregisterEventListeners();
    this._removeFloatingExitButton();
    this._removeStyles();
    this._clearReaderVisibilityOverrides();
  }

  _getMainWindow() {
    if (typeof Zotero !== "undefined" && typeof Zotero.getMainWindow === "function") {
      return Zotero.getMainWindow();
    }
    return Services.wm.getMostRecentWindow("navigator:browser") || Services.wm.getMostRecentWindow("zotero:main");
  }

  _getActiveReaderElement(doc) {
    if (!doc) return null;

    // Preferred: Zotero.Reader API.
    try {
      const activeTabID = Zotero?.getActiveZoteroPane?.()?.getSelectedTabID?.();
      const reader = Zotero?.Reader?.getByTabID?.(activeTabID);
      if (reader) {
        const iframe = reader._iframe || reader._iframeWindow?.frameElement;
        if (iframe) {
          return iframe.closest(".reader") || iframe.closest("#zotero-reader") || iframe;
        }
      }
    } catch (e) {
      // continue with DOM fallback
    }

    // DOM fallback: search for the currently visible reader container.
    const findVisible = (selector) => {
      for (const el of doc.querySelectorAll(selector)) {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        if (cs && cs.display !== "none" && cs.visibility !== "hidden") {
          return el;
        }
      }
      return null;
    };

    return findVisible("#zotero-reader, #zotero-reader-container, .reader, .reader-container")
      || doc.querySelector("#zotero-reader, #zotero-reader-container, .reader, .reader-container");
  }

  _buildCSS() {
    return `
/* Reading mode chrome hide rules */
:root.reading-mode-active #zotero-collections-pane,
:root.reading-mode-active #zotero-items-pane,
:root.reading-mode-active #zotero-item-pane,
:root.reading-mode-active #tab-bar-container,
:root.reading-mode-active .zotero-tag-selector-container,
:root.reading-mode-active .zotero-splitter,
:root.reading-mode-active #zotero-tabs-toolbar,
:root.reading-mode-active toolbar,
:root.reading-mode-active /*[data-rm-bypass]*/ { display: none !important; visibility: hidden !important; }

/* Fullscreen reader container style */
:root.reading-mode-active #zotero-reader,
:root.reading-mode-active #zotero-reader-container,
:root.reading-mode-active .reader,
:root.reading-mode-active .reader-container {
  position: fixed !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  margin: 0 !important;
  padding: 0 !important;
  z-index: 2147483646 !important;
  background: #fff !important;
}

:root.reading-mode-active .reader .toolbar,
:root.reading-mode-active #zotero-reader .toolbar,
:root.reading-mode-active #zotero-reader-container .toolbar {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  height: 0 !important;
}
`;
  }

  _injectStyles() {
    const doc = this._mainWindow.document;
    if (doc.getElementById("zotero-reading-mode-styles")) return;
    const style = doc.createElement("style");
    style.id = "zotero-reading-mode-styles";
    style.textContent = this._buildCSS();
    (doc.head || doc.documentElement).appendChild(style);
    this._styleElement = style;
  }

  _removeStyles() {
    if (this._styleElement) {
      this._styleElement.remove();
      this._styleElement = null;
    }
    const leftover = this._mainWindow?.document?.getElementById("zotero-reading-mode-styles");
    if (leftover) leftover.remove();
  }

  _registerEventListeners() {
    const doc = this._mainWindow.document;
    doc.addEventListener("keydown", this._onKeyDown, true);
    doc.addEventListener("fullscreenchange", this._onFullscreenChange);
    doc.addEventListener("mozfullscreenchange", this._onFullscreenChange);
    this._mainWindow.addEventListener("sizemodechange", this._onFullscreenChange);
  }

  _unregisterEventListeners() {
    if (!this._mainWindow) return;
    const doc = this._mainWindow.document;
    doc.removeEventListener("keydown", this._onKeyDown, true);
    doc.removeEventListener("fullscreenchange", this._onFullscreenChange);
    doc.removeEventListener("mozfullscreenchange", this._onFullscreenChange);
    this._mainWindow.removeEventListener("sizemodechange", this._onFullscreenChange);
  }

  _onKeyDown(event) {
    if (event.code !== "F11" || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    this.toggle();
  }

  _onFullscreenChange() {
    const doc = this._mainWindow?.document;
    const inDOMFullscreen = !!doc?.fullscreenElement || !!doc?.mozFullScreenElement;
    if (!this._mainWindow?.fullScreen && !inDOMFullscreen && this._isActive) {
      this._deactivate(false);
    }
  }

  _injectReaderToolbarButtons() {
    const doc = this._mainWindow.document;
    const callback = () => this._addToolbarButtons();
    this._toolbarObserver = new MutationObserver(callback);
    this._toolbarObserver.observe(doc.body, { childList: true, subtree: true });
    this._addToolbarButtons();
  }

  _addToolbarButtons() {
    if (!this._mainWindow) return;
    const doc = this._mainWindow.document;
    const toolbars = doc.querySelectorAll(".reader .toolbar, #zotero-reader .toolbar, #zotero-reader-container .toolbar");
    for (const toolbar of toolbars) {
      if (!toolbar.querySelector("[data-reading-mode-btn]")) {
        const btn = this._createToggleButton();
        toolbar.appendChild(btn);
      }
    }
  }

  _createToggleButton() {
    const btn = this._mainWindow.document.createElement("button");
    btn.className = "reading-mode-toolbar-btn";
    btn.setAttribute("data-reading-mode-btn", "1");
    btn.title = "Toggle Reading Mode (F11)";
    btn.textContent = "📖";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });
    return btn;
  }

  _removeFloatingExitButton() {
    if (this._floatingExitBtn && this._floatingExitBtn.parentNode) {
      this._floatingExitBtn.remove();
    }
    this._floatingExitBtn = null;
  }

  _syncActiveReaderVisibility() {
    const doc = this._mainWindow?.document;
    if (!doc || !this._isActive) return;

    const active = this._getActiveReaderElement(doc);
    const readers = doc.querySelectorAll("#zotero-reader, #zotero-reader-container, .reader, .reader-container");
    readers.forEach((r) => {
      if (r === active) {
        r.style.setProperty("visibility", "visible", "important");
        r.style.setProperty("display", "block", "important");
      } else {
        r.style.removeProperty("visibility");
        r.style.removeProperty("display");
      }
    });
  }

  _clearReaderVisibilityOverrides() {
    const doc = this._mainWindow?.document;
    if (!doc) return;
    const readers = doc.querySelectorAll("#zotero-reader, #zotero-reader-container, .reader, .reader-container");
    readers.forEach((r) => {
      r.style.removeProperty("visibility");
      r.style.removeProperty("display");
    });
  }

  _startTabSyncTimer() {
    if (this._tabSyncTimer) return;
    this._tabSyncTimer = this._mainWindow.setInterval(() => this._syncActiveReaderVisibility(), 200);
  }

  _stopTabSyncTimer() {
    if (!this._tabSyncTimer) return;
    this._mainWindow.clearInterval(this._tabSyncTimer);
    this._tabSyncTimer = null;
  }

  _activate() {
    if (!this._mainWindow) return;
    const doc = this._mainWindow.document;

    doc.documentElement.classList.add("reading-mode-active");
    this._isActive = true;

    this._clearReaderVisibilityOverrides();
    this._syncActiveReaderVisibility();
    this._startTabSyncTimer();

    const reader = this._getActiveReaderElement(doc);
    if (reader?.requestFullscreen) {
      reader.requestFullscreen().catch(() => {
        this._mainWindow.fullScreen = true;
      });
    } else {
      this._mainWindow.fullScreen = true;
    }

    if (typeof Zotero !== "undefined") Zotero.debug("ReadingMode: activated");
  }

  _deactivate(exitFullscreen) {
    if (!this._mainWindow) return;
    const doc = this._mainWindow.document;

    doc.documentElement.classList.remove("reading-mode-active");
    this._isActive = false;

    this._stopTabSyncTimer();
    this._clearReaderVisibilityOverrides();

    if (exitFullscreen) {
      if (doc.fullscreenElement) {
        doc.exitFullscreen().catch(() => {});
      }
      if (this._mainWindow.fullScreen) {
        this._mainWindow.fullScreen = false;
      }
    }

    if (typeof Zotero !== "undefined") Zotero.debug("ReadingMode: deactivated");
  }

  toggle() {
    if (this._isActive) {
      this._deactivate(true);
    } else {
      this._activate();
    }
  }
}
