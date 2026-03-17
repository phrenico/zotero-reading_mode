/**
 * Zotero Reading Mode – bootstrap.js
 *
 * Bootstrapped Zotero 8 extension that adds a fullscreen reading mode for
 * the built-in PDF viewer.  Activation hides the surrounding Zotero chrome
 * (collections pane, items pane, tab bar) and calls the HTML5 Fullscreen API
 * on the reader container so the document fills the entire screen.
 *
 * Keyboard shortcut: Ctrl+Shift+F  (Windows / Linux)
 *                    Cmd+Shift+F   (macOS)
 * A toggle button is also injected into every open reader toolbar and kept in
 * sync with the current state via a MutationObserver.
 *
 * All event listeners, injected DOM nodes and style elements are removed on
 * shutdown so the plugin leaves no trace in memory.
 */

"use strict";

// ---------------------------------------------------------------------------
// Module-level singleton – created in startup(), destroyed in shutdown()
// ---------------------------------------------------------------------------
var _readingModeInstance = null;

// ---------------------------------------------------------------------------
// Bootstrap lifecycle hooks required by Zotero / Firefox
// ---------------------------------------------------------------------------

function startup(data, reason) { // eslint-disable-line no-unused-vars
  const _doStartup = () => {
    try {
      _readingModeInstance = new ReadingMode(data.rootURI);
      _readingModeInstance.init();
    } catch (e) {
      Components.utils.reportError("ReadingMode startup error: " + e);
    }
  };

  if (typeof Zotero !== "undefined" && Zotero.initialized) {
    _doStartup();
  } else if (typeof Zotero !== "undefined") {
    Zotero.initializationPromise.then(_doStartup).catch((e) => {
      Components.utils.reportError("ReadingMode init error: " + e);
    });
  } else {
    // Fallback: wait a tick for Zotero to be available
    Services.tm.dispatchToMainThread(_doStartup);
  }
}

function shutdown(data, reason) { // eslint-disable-line no-unused-vars
  if (_readingModeInstance) {
    try {
      _readingModeInstance.destroy();
    } catch (e) {
      Components.utils.reportError("ReadingMode shutdown error: " + e);
    }
    _readingModeInstance = null;
  }
}

function install(data, reason) {} // eslint-disable-line no-unused-vars
function uninstall(data, reason) {} // eslint-disable-line no-unused-vars

// ---------------------------------------------------------------------------
// ReadingMode – all plugin logic lives here
// ---------------------------------------------------------------------------

/**
 * Manages the fullscreen reading mode for a single Zotero main window.
 *
 * Design notes
 * ─────────────
 * • A <style> element is injected into document.head once; its ruleset hides
 *   every non-reader panel whenever the `reading-mode-active` class is present
 *   on the document root element.
 *
 * • A MutationObserver watches the whole document body for new .reader toolbar
 *   sections and injects a toggle button each time one appears.  Buttons
 *   already injected are tracked in `_injectedButtons`; stale (detached)
 *   references are pruned on every state update.
 *
 * • The HTML5 Fullscreen API is called on the best available container
 *   element.  The `fullscreenchange` event is listened for so that pressing
 *   Esc (which the browser handles natively) automatically rolls back the CSS
 *   state change as well.
 *
 * • `destroy()` is idempotent and removes every listener, observer, button
 *   and style element injected by the plugin.
 */
class ReadingMode {
  /**
   * @param {string} rootURI  – The rootURI of the XPI (unused today but
   *                            reserved for loading sub-scripts in future).
   */
  constructor(rootURI) {
    this._rootURI = rootURI;

    // Runtime state
    this._isActive = false;
    this._mainWindow = null;

    // DOM references that must be cleaned up
    this._styleElement = null;
    this._injectedButtons = [];   // Array<HTMLButtonElement>
    this._toolbarObserver = null; // MutationObserver

    // Bound event listeners stored so they can be removed with the exact same
    // function reference.
    this._onKeyDown = null;
    this._onFullscreenChange = null;
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  init() {
    this._mainWindow = this._getMainWindow();
    if (!this._mainWindow) {
      Components.utils.reportError("ReadingMode: could not obtain main window");
      return;
    }

    this._injectStyles();
    this._registerKeyboardShortcut();
    this._registerFullscreenHandler();
    this._startToolbarObserver();
  }

  /** Return the primary Zotero main window. */
  _getMainWindow() {
    if (typeof Zotero !== "undefined" && typeof Zotero.getMainWindow === "function") {
      return Zotero.getMainWindow();
    }
    // Fallback for environments where Zotero.getMainWindow is unavailable
    return Services.wm.getMostRecentWindow("navigator:browser")
        || Services.wm.getMostRecentWindow("zotero:main");
  }

  // -------------------------------------------------------------------------
  // CSS injection
  // -------------------------------------------------------------------------

  /**
   * Inject a <style> element that:
   *  1. Hides every non-reader panel while `reading-mode-active` is present on
   *     the root element.
   *  2. Styles the toolbar toggle button.
   */
  _injectStyles() {
    const doc = this._mainWindow.document;

    // Guard: don't double-inject
    if (doc.getElementById("zotero-reading-mode-styles")) {
      return;
    }

    const style = doc.createElement("style");
    style.id = "zotero-reading-mode-styles";
    style.textContent = this._buildCSS();

    // Append to <head>; fall back to <html> root if <head> is absent
    (doc.head || doc.documentElement).appendChild(style);
    this._styleElement = style;
  }

  _buildCSS() {
    return `
/* ── Zotero Reading Mode ────────────────────────────────────────────────── */

/*
 * When reading mode is active we hide every panel that surrounds the reader.
 * Multiple selector variants are listed because the exact IDs/classes used by
 * Zotero's React UI can differ across minor releases.
 */
:root.reading-mode-active #zotero-collections-pane,
:root.reading-mode-active #zotero-items-pane,
:root.reading-mode-active #zotero-item-pane,
:root.reading-mode-active .zotero-tag-selector-container,
:root.reading-mode-active #tab-bar-container,
:root.reading-mode-active .tab-bar-container,
:root.reading-mode-active #zotero-layout-switcher,
:root.reading-mode-active .layout-switcher,
:root.reading-mode-active splitter,
:root.reading-mode-active .splitter {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}

/*
 * Expand the reader container to fill all available space once the surrounding
 * panels have been hidden.
 */
:root.reading-mode-active #zotero-reader,
:root.reading-mode-active #zotero-reader-container,
:root.reading-mode-active .reader-container,
:root.reading-mode-active .reader {
  flex: 1 1 auto !important;
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  height: 100% !important;
}

/* Keep the reader visible and expanded inside the fullscreen element */
:fullscreen #zotero-reader,
:fullscreen #zotero-reader-container,
:fullscreen .reader-container,
:fullscreen .reader,
:-webkit-full-screen #zotero-reader,
:-moz-full-screen #zotero-reader {
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  flex: 1 1 auto !important;
}

/* ── Toggle button ─────────────────────────────────────────────────────── */

.reading-mode-toolbar-btn {
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  margin: 0 2px;
  line-height: 1;
  color: inherit;
  opacity: 0.72;
  transition: opacity 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
  vertical-align: middle;
}

.reading-mode-toolbar-btn:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.18);
}

.reading-mode-toolbar-btn:focus-visible {
  outline: 2px solid var(--accent-blue, #0071BC);
  outline-offset: 1px;
}

.reading-mode-toolbar-btn[aria-pressed="true"],
.reading-mode-toolbar-btn.active {
  opacity: 1;
  color: var(--accent-blue, #0071BC);
  background: rgba(0, 113, 188, 0.10);
  border-color: rgba(0, 113, 188, 0.30);
}

.reading-mode-toolbar-btn svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
  pointer-events: none;
  display: block;
}
/* ─────────────────────────────────────────────────────────────────────── */
`;
  }

  _removeStyles() {
    if (this._styleElement) {
      this._styleElement.remove();
      this._styleElement = null;
    }
    // Belt-and-suspenders: also remove any orphaned element by ID
    const orphan = this._mainWindow?.document?.getElementById("zotero-reading-mode-styles");
    if (orphan) {
      orphan.remove();
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcut
  // -------------------------------------------------------------------------

  _registerKeyboardShortcut() {
    const doc = this._mainWindow.document;

    this._onKeyDown = (event) => {
      if (!this._isReadingModeShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggle();
    };

    // Capture phase so we see the event before the PDF viewer does
    doc.addEventListener("keydown", this._onKeyDown, /* capture */ true);
  }

  /**
   * Returns true when the event matches the platform-correct shortcut.
   *   macOS  : Cmd  + Shift + F
   *   Others : Ctrl + Shift + F
   *
   * `event.code` is used instead of `event.key` because `event.code` is
   * layout-independent and always maps to the physical key position, making
   * the shortcut work correctly across all keyboard layouts.
   */
  _isReadingModeShortcut(event) {
    const isMac = Services.appinfo.OS === "Darwin";
    const primaryModifier = isMac ? event.metaKey : event.ctrlKey;
    return primaryModifier && event.shiftKey && event.code === "KeyF";
  }

  // -------------------------------------------------------------------------
  // Fullscreen-change handler (handles Esc key exit)
  // -------------------------------------------------------------------------

  _registerFullscreenHandler() {
    const doc = this._mainWindow.document;

    this._onFullscreenChange = () => {
      // The browser exited fullscreen (e.g. user pressed Esc) but our CSS
      // class is still active – roll it back gracefully.
      if (!doc.fullscreenElement && this._isActive) {
        this._deactivate(/* exitFullscreen */ false);
      }
    };

    doc.addEventListener("fullscreenchange", this._onFullscreenChange);
    // Firefox-prefixed variant (older builds)
    doc.addEventListener("mozfullscreenchange", this._onFullscreenChange);
  }

  // -------------------------------------------------------------------------
  // MutationObserver – toolbar button injection
  // -------------------------------------------------------------------------

  /**
   * Watch the entire document body for changes.  Whenever the DOM mutates
   * (e.g. a new reader tab is opened, React re-renders the toolbar) we try to
   * inject our toggle button into any reader toolbar that doesn't have one yet.
   *
   * The callback is debounced (100 ms) to avoid performing DOM queries on
   * every individual mutation in a burst, which is common during React renders.
   */
  _startToolbarObserver() {
    const doc = this._mainWindow.document;

    // Attempt an immediate injection in case the reader is already open
    this._tryInjectAllButtons(doc);

    // Use the window's own MutationObserver to avoid sandbox issues
    const MO = this._mainWindow.MutationObserver
             || this._mainWindow.wrappedJSObject?.MutationObserver
             || MutationObserver;

    let debounceTimer = null;

    this._toolbarObserver = new MO(() => {
      if (debounceTimer !== null) {
        this._mainWindow.clearTimeout(debounceTimer);
      }
      debounceTimer = this._mainWindow.setTimeout(() => {
        debounceTimer = null;
        this._tryInjectAllButtons(doc);
      }, 100);
    });

    this._toolbarObserver.observe(doc.body, {
      childList: true,
      subtree: true,
    });
  }

  /**
   * Walk every reader toolbar container found in `doc` and inject a button
   * into those that don't already have one.
   *
   * Also prunes the `_injectedButtons` tracking array here, since DOM
   * mutations are the natural moment when buttons may have been removed.
   */
  _tryInjectAllButtons(doc) {
    // Prune stale (detached) button references so the array stays small
    this._injectedButtons = this._injectedButtons.filter((btn) => btn.isConnected);

    // Ordered list of selectors – most specific first, most generic last.
    // We stop at the first selector that yields at least one element.
    const candidateSelectors = [
      ".reader .toolbar .end",
      ".reader .toolbar-end",
      ".reader .toolbar .toolbar-right",
      ".reader .toolbar-right",
      ".reader .toolbar",
    ];

    for (const sel of candidateSelectors) {
      const containers = doc.querySelectorAll(sel);
      if (!containers.length) continue;

      for (const container of containers) {
        if (!container.querySelector(".reading-mode-toolbar-btn")) {
          const btn = this._createButton(doc);
          // Apply current active state immediately so the button looks right
          // if reading mode was already active when the toolbar appeared.
          if (this._isActive) {
            btn.classList.add("active");
            btn.setAttribute("aria-pressed", "true");
          }
          container.appendChild(btn);
          this._injectedButtons.push(btn);
        }
      }
      // Stop searching once we found and used a selector
      break;
    }
  }

  /**
   * Build the toolbar toggle button element.
   *
   * The button uses an inline SVG (the standard Material expand-icon) so it
   * looks sharp at any DPI and requires no external assets.
   */
  _createButton(doc) {
    const isMac = Services.appinfo.OS === "Darwin";
    const shortcut = isMac ? "Cmd+Shift+F" : "Ctrl+Shift+F";

    const btn = doc.createElement("button");
    btn.className = "reading-mode-toolbar-btn";
    btn.title = `Toggle Reading Mode (${shortcut})`;
    btn.setAttribute("aria-label", "Toggle Reading Mode");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("data-reading-mode-btn", "1");

    // Material Design "fullscreen" icon path (Apache 2.0)
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
    </svg>`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });

    return btn;
  }

  // -------------------------------------------------------------------------
  // Toggle / activate / deactivate
  // -------------------------------------------------------------------------

  toggle() {
    if (this._isActive) {
      this._deactivate(/* exitFullscreen */ true);
    } else {
      this._activate();
    }
  }

  _activate() {
    if (!this._mainWindow) return;

    const doc = this._mainWindow.document;

    // 1. Apply CSS state class
    doc.documentElement.classList.add("reading-mode-active");
    this._isActive = true;

    // 2. Sync toolbar buttons
    this._syncButtonStates();

    // 3. Enter HTML5 fullscreen on the best available container
    const target = this._findFullscreenTarget(doc);
    if (target && typeof target.requestFullscreen === "function") {
      target.requestFullscreen().catch((err) => {
        // Fullscreen can be refused if the document is not focused or a
        // dialog is open.  Log but don't break – the CSS hiding still works.
        Components.utils.reportError("ReadingMode: requestFullscreen failed – " + err);
      });
    } else if (target && typeof target.mozRequestFullScreen === "function") {
      target.mozRequestFullScreen();
    }

    if (typeof Zotero !== "undefined") {
      Zotero.debug("ReadingMode: activated");
    }
  }

  _deactivate(exitFullscreen) {
    if (!this._mainWindow) return;

    const doc = this._mainWindow.document;

    // 1. Remove CSS state class
    doc.documentElement.classList.remove("reading-mode-active");
    this._isActive = false;

    // 2. Sync toolbar buttons
    this._syncButtonStates();

    // 3. Exit fullscreen if still active (and caller asked us to do so)
    if (exitFullscreen && doc.fullscreenElement) {
      doc.exitFullscreen().catch((err) => {
        Components.utils.reportError("ReadingMode: exitFullscreen failed – " + err);
      });
    }

    if (typeof Zotero !== "undefined") {
      Zotero.debug("ReadingMode: deactivated");
    }
  }

  /**
   * Find the best element to pass to requestFullscreen().
   *
   * Preference order:
   *  1. #zotero-reader (the dedicated reader wrapper element)
   *  2. #zotero-reader-container
   *  3. .reader-container
   *  4. .reader (the React reader root)
   *  5. document.documentElement (whole window as a safe fallback)
   */
  _findFullscreenTarget(doc) {
    const candidates = [
      "#zotero-reader",
      "#zotero-reader-container",
      ".reader-container",
      ".reader",
    ];
    for (const sel of candidates) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return doc.documentElement;
  }

  // -------------------------------------------------------------------------
  // Button state synchronisation
  // -------------------------------------------------------------------------

  _syncButtonStates() {
    // Prune stale (detached from DOM) button references
    this._injectedButtons = this._injectedButtons.filter((btn) => btn.isConnected);

    const isMac = Services.appinfo.OS === "Darwin";
    const shortcut = isMac ? "Cmd+Shift+F" : "Ctrl+Shift+F";

    for (const btn of this._injectedButtons) {
      btn.setAttribute("aria-pressed", String(this._isActive));

      if (this._isActive) {
        btn.classList.add("active");
        btn.title = `Exit Reading Mode (${shortcut})`;
      } else {
        btn.classList.remove("active");
        btn.title = `Toggle Reading Mode (${shortcut})`;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Destruction / cleanup
  // -------------------------------------------------------------------------

  /**
   * Remove every listener, observer, button and style element injected by the
   * plugin.  Called by the `shutdown` lifecycle hook and safe to call multiple
   * times.
   */
  destroy() {
    // Deactivate reading mode first (rolls back CSS class + exits fullscreen)
    if (this._isActive) {
      try {
        this._deactivate(/* exitFullscreen */ true);
      } catch (e) {
        Components.utils.reportError("ReadingMode destroy/_deactivate error: " + e);
      }
    }

    const doc = this._mainWindow?.document;

    // Remove keyboard listener
    if (doc && this._onKeyDown) {
      doc.removeEventListener("keydown", this._onKeyDown, /* capture */ true);
      this._onKeyDown = null;
    }

    // Remove fullscreen-change listeners
    if (doc && this._onFullscreenChange) {
      doc.removeEventListener("fullscreenchange", this._onFullscreenChange);
      doc.removeEventListener("mozfullscreenchange", this._onFullscreenChange);
      this._onFullscreenChange = null;
    }

    // Disconnect the MutationObserver
    if (this._toolbarObserver) {
      this._toolbarObserver.disconnect();
      this._toolbarObserver = null;
    }

    // Remove injected toolbar buttons from the DOM
    for (const btn of this._injectedButtons) {
      try {
        if (btn.parentNode) {
          btn.parentNode.removeChild(btn);
        }
      } catch (_) {}
    }
    this._injectedButtons = [];

    // Remove injected <style> element
    this._removeStyles();

    // Clear the window reference last
    this._mainWindow = null;

    if (typeof Zotero !== "undefined") {
      Zotero.debug("ReadingMode: destroyed");
    }
  }
}
