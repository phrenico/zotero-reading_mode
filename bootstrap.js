/**
 * Zotero Reading Mode – bootstrap.js
 *
 * Bootstrapped Zotero 8 extension that adds a fullscreen reading mode for
 * the built-in PDF viewer.  Activation hides the surrounding Zotero chrome
 * (collections pane, items pane, tab bar) and calls the HTML5 Fullscreen API
 * on the reader container so the document fills the entire screen.
 *
 * Keyboard shortcut: F11 (all platforms)
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
      dump("ReadingMode startup error: " + e);
    }
  };

  if (typeof Zotero !== "undefined" && Zotero.initialized) {
    _doStartup();
  } else if (typeof Zotero !== "undefined") {
    Zotero.initializationPromise.then(_doStartup).catch((e) => {
      dump("ReadingMode init error: " + e);
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
      dump("ReadingMode shutdown error: " + e);
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
    this._floatingExitBtn = null; // Floating exit button for reading mode
    this._readerStyles = [];      // Style elements injected into reader iframes
    this._collapsedSiblings = [];  // Non-reader siblings hidden by JS
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
      dump("ReadingMode: could not obtain main window");
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
 * This includes: side panes, tab bar, menu bar, annotation toolbar, sync
 * button, tabs-menu button, splitters, and layout switchers.
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
:root.reading-mode-active .splitter,
/* Main menu bar */
:root.reading-mode-active #main-menubar,
:root.reading-mode-active #toolbar-menubar,
:root.reading-mode-active menubar,
/* Window titlebar (XUL) */
:root.reading-mode-active #titlebar,
:root.reading-mode-active .titlebar-buttonbox-container,
:root.reading-mode-active .titlebar-buttonbox,
/* Tabs toolbar row (contains sync button + list-all-tabs button) */
:root.reading-mode-active #zotero-tabs-toolbar,
/* Sync button */
:root.reading-mode-active #zotero-tb-sync,
:root.reading-mode-active #zotero-tb-sync-error,
/* List-all-tabs button */
:root.reading-mode-active #zotero-tb-tabs-menu,
/* Toolbox wrapper (contains menubar + tabs toolbar; can leave a gap) */
:root.reading-mode-active #navigator-toolbox,
:root.reading-mode-active toolbox {
  display: none !important;
  visibility: collapse !important;
  pointer-events: none !important;
  height: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  border: none !important;
  overflow: hidden !important;
  -moz-appearance: none !important;
  appearance: none !important;
}

/* Zero out any margin/padding on the XUL window, root, and body */
window,
:root.reading-mode-active,
:root.reading-mode-active[inFullscreen] {
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  -moz-appearance: none !important;
  appearance: none !important;
}
:root.reading-mode-active body {
  margin: 0 !important;
  padding: 0 !important;
}

/* Hide the reader's own annotation / top toolbar */
:root.reading-mode-active .reader .toolbar,
:root.reading-mode-active .reader .toolbar-container,
:root.reading-mode-active .reader > .split-view > .toolbar,
:root.reading-mode-active #zotero-reader > .toolbar,
:root.reading-mode-active #zotero-reader-container > .toolbar,
:root.reading-mode-active .reader toolbar {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
  height: 0 !important;
  overflow: hidden !important;
}

/*
 * Expand the reader container to fill all available space once the surrounding
 * panels have been hidden.  Use fixed positioning to overlay everything.
 */
:root.reading-mode-active #zotero-reader,
:root.reading-mode-active #zotero-reader-container {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  min-width: 0 !important;
  min-height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  z-index: 2147483646 !important;
  background: white !important;
}

/*
 * When the reader element is in DOM-level fullscreen via requestFullscreen(),
 * the :fullscreen pseudo-class applies.  Fill 100%.
 */
#zotero-reader:fullscreen,
#zotero-reader-container:fullscreen,
#zotero-reader:-moz-full-screen,
#zotero-reader-container:-moz-full-screen {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  background: white !important;
}

/* Children inside a :fullscreen element should also fill it */
:fullscreen .reader-container,
:fullscreen .reader,
:-moz-full-screen .reader-container,
:-moz-full-screen .reader {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
}

:fullscreen browser,
:fullscreen iframe,
:-moz-full-screen browser,
:-moz-full-screen iframe {
  width: 100% !important;
  height: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
}

:root.reading-mode-active .reader-container,
:root.reading-mode-active .reader {
  flex: 1 1 auto !important;
  width: 100% !important;
  max-width: 100% !important;
  min-width: 0 !important;
  height: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
}

/* The outer chrome wrapper needs to be a simple column that fills the window */
:root.reading-mode-active #browser,
:root.reading-mode-active #appcontent {
  flex: 1 1 auto !important;
  height: 100% !important;
  max-height: 100% !important;
}

/* browser/iframe that hosts the reader should fill its parent */
:root.reading-mode-active #zotero-reader browser,
:root.reading-mode-active #zotero-reader iframe,
:root.reading-mode-active #zotero-reader-container browser,
:root.reading-mode-active #zotero-reader-container iframe,
:root.reading-mode-active .reader browser,
:root.reading-mode-active .reader iframe {
  flex: 1 1 auto !important;
  width: 100% !important;
  height: 100% !important;
  max-height: 100% !important;
  min-height: 0 !important;
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

/* ── Floating exit button (visible only in reading mode) ───────────────── */

.reading-mode-floating-exit {
  display: none;
}

:root.reading-mode-active .reading-mode-floating-exit {
  display: flex;
  position: fixed;
  top: 8px;
  right: 8px;
  z-index: 2147483647;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  border: none;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.25s ease;
  padding: 0;
}

:root.reading-mode-active .reading-mode-floating-exit:hover,
:root.reading-mode-active .reading-mode-floating-exit:focus-visible {
  opacity: 1;
  background: rgba(0, 0, 0, 0.72);
}

.reading-mode-floating-exit svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
  pointer-events: none;
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
   * Returns true when the event is F11 with no modifiers.
   */
  _isReadingModeShortcut(event) {
    return event.code === "F11" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  }

  // -------------------------------------------------------------------------
  // Fullscreen-change handler (handles Esc key exit)
  // -------------------------------------------------------------------------

  _registerFullscreenHandler() {
    const win = this._mainWindow;
    const doc = win.document;

    this._onFullscreenChange = () => {
      // The user exited fullscreen (e.g. pressed Esc) but reading mode is
      // still active – roll it back gracefully.
      const inDOMFullscreen = !!doc.fullscreenElement || !!doc.mozFullScreenElement;
      if (!win.fullScreen && !inDOMFullscreen && this._isActive) {
        this._deactivate(/* exitFullscreen */ false);
      }
    };

    doc.addEventListener("fullscreenchange", this._onFullscreenChange);
    doc.addEventListener("mozfullscreenchange", this._onFullscreenChange);
    // XUL-specific: fires when the window's size mode changes (fullscreen ↔ normal)
    win.addEventListener("sizemodechange", this._onFullscreenChange);
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
        // When reading mode is active, inject styles into newly loaded reader iframes
        if (this._isActive) {
          this._injectReaderContentStyles();
          this._hideReaderToolbarsJS();
        }
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
    const shortcut = "F11";

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
    const root = doc.documentElement;

    // 1. Apply CSS state class
    root.classList.add("reading-mode-active");
    this._isActive = true;

    // 1b. Set XUL fullscreen attributes (mimics Firefox's own fullscreen).
    this._origSizemode = root.getAttribute("sizemode") || "";
    root.setAttribute("inFullscreen", "true");
    root.setAttribute("sizemode", "fullscreen");

    // 2. Show floating exit button
    this._showFloatingExitButton(doc);

    // 3. Sync toolbar buttons
    this._syncButtonStates();

    // 4. Force-collapse XUL chrome (toolbox etc.) via native attributes
    this._collapseXULChrome(doc);

    // 5. Hide toolbars inside reader iframes via JS + CSS
    this._injectReaderContentStyles();
    this._hideReaderToolbarsJS();

    // 5b. Walk DOM: hide every element that isn't an ancestor of the reader
    this._collapseNonReaderSiblings(doc);

    // 6. Enter fullscreen — try requestFullscreen() on the reader element
    //    first (DOM-level fullscreen bypasses XUL layout entirely), fall
    //    back to window.fullScreen if unavailable.
    const reader = doc.querySelector("#zotero-reader")
                || doc.querySelector("#zotero-reader-container")
                || doc.querySelector(".reader-container")
                || doc.querySelector(".reader");

    this._fullscreenElement = null;
    if (reader && typeof reader.requestFullscreen === "function") {
      reader.requestFullscreen().then(() => {
        this._fullscreenElement = reader;
        this._postFullscreenSetup(doc);
      }).catch(() => {
        // Fallback: window-level fullscreen
        this._mainWindow.fullScreen = true;
        this._mainWindow.setTimeout(() => this._postFullscreenSetup(doc), 400);
      });
    } else if (reader && typeof reader.mozRequestFullScreen === "function") {
      reader.mozRequestFullScreen();
      this._fullscreenElement = reader;
      this._mainWindow.setTimeout(() => this._postFullscreenSetup(doc), 400);
    } else {
      // Fallback: window-level fullscreen
      this._mainWindow.fullScreen = true;
      this._mainWindow.setTimeout(() => this._postFullscreenSetup(doc), 400);
    }

    if (typeof Zotero !== "undefined") {
      Zotero.debug("ReadingMode: activated");
    }
  }

  /**
   * Post-fullscreen setup: re-inject styles and fit page height.
   * Called after the fullscreen transition completes.
   */
  _postFullscreenSetup(doc) {
    if (!this._isActive) return;
    this._collapseXULChrome(doc);
    this._injectReaderContentStyles();
    this._hideReaderToolbarsJS();
    this._collapseNonReaderSiblings(doc);
    this._fitPageHeight();

    // Dump diagnostic info so user can paste it if gap persists
    this._dumpDiagnostics(doc);
  }

  /**
   * Dump layout diagnostics to the Zotero debug log.
   * Output is visible in Help → Debug Output Logging → View Output.
   */
  _dumpDiagnostics(doc) {
    const log = (msg) => {
      dump("RM-DIAG: " + msg + "\n");
      if (typeof Zotero !== "undefined") Zotero.debug("RM-DIAG: " + msg);
    };

    log("--- Reading Mode Diagnostics ---");
    log("window.fullScreen=" + this._mainWindow.fullScreen);
    log("document.fullscreenElement=" + (doc.fullscreenElement ? doc.fullscreenElement.tagName + "#" + doc.fullscreenElement.id : "null"));
    log("fullscreenElement (ours)=" + (this._fullscreenElement ? this._fullscreenElement.tagName + "#" + this._fullscreenElement.id : "null"));
    log("window.innerWidth=" + this._mainWindow.innerWidth + " innerHeight=" + this._mainWindow.innerHeight);
    log("window.outerWidth=" + this._mainWindow.outerWidth + " outerHeight=" + this._mainWindow.outerHeight);
    log("screen.width=" + this._mainWindow.screen.width + " height=" + this._mainWindow.screen.height);

    const root = doc.documentElement;
    log("root sizemode=" + root.getAttribute("sizemode") + " inFullscreen=" + root.getAttribute("inFullscreen"));
    const rootRect = root.getBoundingClientRect();
    log("root rect: top=" + rootRect.top + " height=" + rootRect.height);

    // Find reader and report its position
    const reader = doc.querySelector("#zotero-reader")
                || doc.querySelector("#zotero-reader-container");
    if (reader) {
      const rRect = reader.getBoundingClientRect();
      const rCS = doc.defaultView.getComputedStyle(reader);
      log("reader (" + reader.tagName + "#" + reader.id + ") rect: top=" + rRect.top +
          " left=" + rRect.left + " width=" + rRect.width + " height=" + rRect.height);
      log("reader computed: position=" + rCS.position + " top=" + rCS.top +
          " display=" + rCS.display + " zIndex=" + rCS.zIndex);
    }

    // Report all visible top-level children
    for (const child of root.children) {
      try {
        const r = child.getBoundingClientRect();
        const cs = doc.defaultView.getComputedStyle(child);
        if (r.height > 0 && cs.display !== "none") {
          log("VISIBLE child: <" + child.tagName + "> id=" + child.id +
              " rect.top=" + Math.round(r.top) + " h=" + Math.round(r.height) +
              " display=" + cs.display + " collapsed=" + child.getAttribute("collapsed"));
        }
      } catch (e) {}
    }

    // Dump reader iframe internal DOM
    log("--- Reader iframe internals ---");
    const browsers = doc.querySelectorAll("browser, iframe");
    for (const b of browsers) {
      try {
        const innerDoc = b.contentDocument;
        if (!innerDoc) continue;
        const bRect = b.getBoundingClientRect();
        if (bRect.height < 10) continue;  // skip invisible iframes
        log("IFRAME: <" + b.tagName + "> src=" + (b.src || b.getAttribute("src") || "?").substring(0, 80) +
            " rect.top=" + Math.round(bRect.top) + " h=" + Math.round(bRect.height));
        // Dump all visible children of the iframe body/root
        const innerRoot = innerDoc.body || innerDoc.documentElement;
        if (innerRoot) {
          for (const child of innerRoot.children) {
            try {
              const cr = child.getBoundingClientRect();
              const ccs = innerDoc.defaultView.getComputedStyle(child);
              if (cr.height > 0 && ccs.display !== "none") {
                log("  IFRAME-CHILD: <" + child.tagName + "> id=" + child.id +
                    " class=" + (child.className || "").toString().substring(0, 60) +
                    " rect.top=" + Math.round(cr.top) + " h=" + Math.round(cr.height) +
                    " display=" + ccs.display);
                // Go one more level deep
                for (const gc of child.children) {
                  try {
                    const gr = gc.getBoundingClientRect();
                    const gcs = innerDoc.defaultView.getComputedStyle(gc);
                    if (gr.height > 0 && gr.height < 200 && gcs.display !== "none") {
                      log("    IFRAME-GC: <" + gc.tagName + "> id=" + gc.id +
                          " class=" + (gc.className || "").toString().substring(0, 60) +
                          " rect.top=" + Math.round(gr.top) + " h=" + Math.round(gr.height));
                    }
                  } catch (e) {}
                }
              }
            } catch (e) {}
          }
        }
      } catch (e) {
        log("IFRAME: access denied (" + e.message + ")");
      }
    }
    log("--- End Diagnostics ---");
  }

  _deactivate(exitFullscreen) {
    if (!this._mainWindow) return;

    const doc = this._mainWindow.document;

    // 1. Remove CSS state class and XUL fullscreen attributes
    const root = doc.documentElement;
    root.classList.remove("reading-mode-active");
    root.removeAttribute("inFullscreen");
    if (this._origSizemode) {
      root.setAttribute("sizemode", this._origSizemode);
    } else {
      root.removeAttribute("sizemode");
    }
    this._isActive = false;

    // 2. Remove floating exit button
    this._removeFloatingExitButton();

    // 3. Sync toolbar buttons
    this._syncButtonStates();

    // 4. Remove any leftover debug styles
    const debugStyle = doc.getElementById("reading-mode-debug-style");
    if (debugStyle) debugStyle.remove();

    // 5. Restore reader iframe styles and toolbar visibility
    this._removeReaderContentStyles();
    this._restoreReaderToolbarsJS();
    this._restoreCollapsedSiblings();

    // 5b. Restore XUL chrome
    this._restoreXULChrome(doc);

    // 6. Exit fullscreen
    if (exitFullscreen) {
      // Exit DOM-level fullscreen if active
      if (doc.fullscreenElement) {
        doc.exitFullscreen().catch(() => {});
      }
      // Also exit window-level fullscreen
      if (this._mainWindow.fullScreen) {
        this._mainWindow.fullScreen = false;
      }
    }
    this._fullscreenElement = null;

    if (typeof Zotero !== "undefined") {
      Zotero.debug("ReadingMode: deactivated");
    }
  }

  // -------------------------------------------------------------------------
  // Floating exit button (shown only during reading mode)
  // -------------------------------------------------------------------------

  _showFloatingExitButton(doc) {
    if (this._floatingExitBtn && this._floatingExitBtn.isConnected) return;

    const shortcut = "F11";

    const btn = doc.createElement("button");
    btn.className = "reading-mode-floating-exit";
    btn.title = `Exit Reading Mode (${shortcut} or Esc)`;
    btn.setAttribute("aria-label", "Exit Reading Mode");

    // "fullscreen exit" icon (Material Design, Apache 2.0)
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
    </svg>`;

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });

    doc.documentElement.appendChild(btn);
    this._floatingExitBtn = btn;
  }

  _removeFloatingExitButton() {
    if (this._floatingExitBtn) {
      if (this._floatingExitBtn.parentNode) {
        this._floatingExitBtn.parentNode.removeChild(this._floatingExitBtn);
      }
      this._floatingExitBtn = null;
    }
  }

  // -------------------------------------------------------------------------
  // Reader iframe style injection (hides annotation toolbar inside reader)
  // -------------------------------------------------------------------------

  /**
   * Find all <browser> / <iframe> elements that host the reader and inject a
   * stylesheet that hides the annotation toolbar.  Called on activate and also
   * from the MutationObserver so newly opened reader tabs are covered.
   */
  _injectReaderContentStyles() {
    const doc = this._mainWindow?.document;
    if (!doc) return;

    // Recursively collect ALL documents (main + every nested iframe/browser)
    const allDocs = [];
    const collectDocs = (d) => {
      for (const frame of d.querySelectorAll("browser, iframe")) {
        try {
          const inner = frame.contentDocument;
          if (inner && inner.documentElement) {
            allDocs.push(inner);
            collectDocs(inner);
          }
        } catch (e) {}
      }
    };
    allDocs.push(doc);
    collectDocs(doc);

    for (const innerDoc of allDocs) {
      try {
        if (innerDoc.getElementById("reading-mode-reader-hide")) continue;

        const style = innerDoc.createElement("style");
        style.id = "reading-mode-reader-hide";
        // Aggressively hide everything that isn't the PDF viewer itself.
        // Add nuclear rule for #split-view
        style.textContent = `
          .toolbar,
          .toolbar-container,
          [class*="toolbar"],
          [class*="Toolbar"],
          header,
          [class*="header"],
          [class*="Header"],
          [class*="sidebar"],
          [class*="Sidebar"],
          .split-view > :first-child:not([class*="view"]):not([class*="View"]):not(iframe),
          [class*="findbar"],
          [class*="Findbar"] {
            display: none !important;
            height: 0 !important;
            min-height: 0 !important;
            max-height: 0 !important;
            overflow: hidden !important;
            padding: 0 !important;
            margin: 0 !important;
            visibility: collapse !important;
          }
          /* Make the viewer/content fill 100% and kill overscroll */
          html, body, #root, .split-view, [class*="view"], [class*="reader"] {
            margin: 0 !important;
            padding: 0 !important;
            height: 100% !important;
            max-height: 100% !important;
            overscroll-behavior: none !important;
          }
          /* Nuclear: force split-view to top=0, margin=0, padding=0, absolute, height=100vh */
          #split-view {
            margin: 0 !important;
            padding: 0 !important;
            top: 0 !important;
            position: absolute !important;
            height: 100vh !important;
          }
          /* PDF.js viewer container overscroll & padding fix */
          #viewerContainer, .viewerContainer,
          [class*="viewerContainer"], [id*="viewerContainer"],
          #viewer, .pdfViewer, [class*="pdfViewer"],
          .spread, [class*="spread"] {
            overscroll-behavior: none !important;
            scroll-padding: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          /* Remove the top gap above the first page — PDF.js adds
             padding/margin before page 1 that causes a visible strip. */
          .page:first-child,
          .page:first-of-type,
          [class*="page"]:first-child,
          [data-page-number="1"] {
            margin-top: 0 !important;
          }
          .pdfViewer > .page:first-child,
          #viewer > .page:first-child {
            margin-top: 0 !important;
            padding-top: 0 !important;
          }
          /* Also zero the bottom gap on the last page */
          .page:last-child,
          .page:last-of-type,
          [class*="page"]:last-child {
            margin-bottom: 0 !important;
          }
          /* Kill rubber-band / bounce on all scrollable containers
             and nuke ALL margin/padding to eliminate any gap. */
          * {
            overscroll-behavior: none !important;
            -webkit-overflow-scrolling: auto !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
          }
        `;
        (innerDoc.head || innerDoc.documentElement).appendChild(style);
        this._readerStyles.push(style);
        // JS override for split-view
        const splitView = innerDoc.getElementById("split-view");
        if (splitView) {
          splitView.style.margin = "0";
          splitView.style.padding = "0";
          splitView.style.top = "0";
          splitView.style.position = "absolute";
          splitView.style.height = "100vh";
        }
        // Diagnostics after injection
        setTimeout(() => {
          if (splitView) {
            const rect = splitView.getBoundingClientRect();
            dump('RM-DIAG: split-view rect.top=' + rect.top + ' height=' + rect.height + '\n');
            if (typeof Zotero !== "undefined") Zotero.debug('RM-DIAG: split-view rect.top=' + rect.top + ' height=' + rect.height);
          }
        }, 500);
      } catch (e) {
        // Cross-origin or not yet loaded – skip
      }
    }
  }

  _removeReaderContentStyles() {
    for (const style of this._readerStyles) {
      try { style.remove(); } catch (e) {}
    }
    this._readerStyles = [];

    // Belt-and-suspenders: recursively search all iframes by ID
    const doc = this._mainWindow?.document;
    if (!doc) return;
    const removeFromDoc = (d) => {
      try {
        const orphan = d.getElementById("reading-mode-reader-hide");
        if (orphan) orphan.remove();
      } catch (e) {}
      for (const frame of d.querySelectorAll("browser, iframe")) {
        try {
          if (frame.contentDocument) removeFromDoc(frame.contentDocument);
        } catch (e) {}
      }
    };
    removeFromDoc(doc);
  }

  // -------------------------------------------------------------------------
  // JS-based toolbar hiding (direct DOM manipulation as fallback)
  // -------------------------------------------------------------------------

  /**
   * Walk every <browser>/<iframe> and the main document, find elements whose
   * class contains "toolbar", and collapse them via inline style.  Stores
   * the original style so we can restore it on deactivation.
   */
  _hideReaderToolbarsJS() {
    if (!this._hiddenToolbarElements) {
      this._hiddenToolbarElements = [];
    }

    const doc = this._mainWindow?.document;
    if (!doc) return;

    // Search in both the main document and inside browser/iframe elements
    const docs = [doc];
    const browsers = doc.querySelectorAll("browser, iframe");
    for (const b of browsers) {
      try {
        if (b.contentDocument) docs.push(b.contentDocument);
        // Also check nested iframes inside content documents
        if (b.contentDocument) {
          for (const inner of b.contentDocument.querySelectorAll("browser, iframe")) {
            try { if (inner.contentDocument) docs.push(inner.contentDocument); } catch (e) {}
          }
        }
      } catch (e) {}
    }

    for (const d of docs) {
      try {
        // Find all elements with "toolbar" in class, header elements, etc.
        const candidates = d.querySelectorAll(
          '[class*="toolbar"], [class*="Toolbar"], .toolbar, .toolbar-container, ' +
          'header, [class*="header"], [class*="Header"], ' +
          '[class*="sidebar"], [class*="Sidebar"], ' +
          '[class*="findbar"], [class*="Findbar"]'
        );
        for (const el of candidates) {
          // Skip our own buttons/elements
          if (el.classList?.contains("reading-mode-toolbar-btn") ||
              el.classList?.contains("reading-mode-floating-exit")) continue;
          // Skip if already hidden by us
          if (el.getAttribute("data-rm-hidden")) continue;

          const orig = el.getAttribute("style") || "";
          el.setAttribute("data-rm-hidden", "1");
          el.setAttribute("data-rm-orig-style", orig);
          el.style.setProperty("display", "none", "important");
          el.style.setProperty("height", "0", "important");
          el.style.setProperty("visibility", "collapse", "important");
          this._hiddenToolbarElements.push(el);
        }
      } catch (e) {}
    }
  }

  _restoreReaderToolbarsJS() {
    if (!this._hiddenToolbarElements) return;
    for (const el of this._hiddenToolbarElements) {
      try {
        const orig = el.getAttribute("data-rm-orig-style") || "";
        el.setAttribute("style", orig);
        el.removeAttribute("data-rm-hidden");
        el.removeAttribute("data-rm-orig-style");
      } catch (e) {}
    }
    this._hiddenToolbarElements = [];
  }

  // -------------------------------------------------------------------------
  // Collapse non-reader siblings (walk DOM from reader to root)
  // -------------------------------------------------------------------------

  /**
   * Find the reader element, walk up to the document root, and at each level
   * hide every sibling that is NOT on the path to the reader.  This removes
   * any unknown wrapper, spacer, or toolbar that sits above/around the reader.
   */
  _collapseNonReaderSiblings(doc) {
    // Find the reader element
    const reader = doc.querySelector("#zotero-reader")
                || doc.querySelector("#zotero-reader-container")
                || doc.querySelector(".reader-container")
                || doc.querySelector(".reader");
    if (!reader) return;

    let current = reader;
    while (current.parentElement) {
      const parent = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling === current) continue;
        // Don't hide our own floating button
        if (sibling.classList?.contains("reading-mode-floating-exit")) continue;
        // Don't hide <script>, <style>, <link> etc.
        const tag = sibling.tagName?.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "link") continue;
        // Skip if already collapsed
        if (sibling.getAttribute("data-rm-sibling-hidden")) continue;

        const orig = sibling.getAttribute("style") || "";
        sibling.setAttribute("data-rm-sibling-hidden", "1");
        sibling.setAttribute("data-rm-sibling-orig-style", orig);
        sibling.style.setProperty("display", "none", "important");
        sibling.style.setProperty("height", "0", "important");
        sibling.style.setProperty("min-height", "0", "important");
        sibling.style.setProperty("max-height", "0", "important");
        sibling.style.setProperty("overflow", "hidden", "important");
        sibling.style.setProperty("padding", "0", "important");
        sibling.style.setProperty("margin", "0", "important");
        sibling.style.setProperty("border", "none", "important");
        this._collapsedSiblings.push(sibling);
      }
      // Also zero out padding/margin on the parent itself
      if (!parent.getAttribute("data-rm-parent-zeroed")) {
        const origP = parent.getAttribute("style") || "";
        parent.setAttribute("data-rm-parent-zeroed", "1");
        parent.setAttribute("data-rm-parent-orig-style", origP);
        parent.style.setProperty("padding", "0", "important");
        parent.style.setProperty("margin", "0", "important");
        parent.style.setProperty("border", "none", "important");
        this._collapsedSiblings.push(parent);
      }
      current = parent;
    }
    // Also zero out document.documentElement padding/margin
    doc.documentElement.style.setProperty("padding", "0", "important");
    doc.documentElement.style.setProperty("margin", "0", "important");
  }

  _restoreCollapsedSiblings() {
    for (const el of this._collapsedSiblings) {
      try {
        if (el.getAttribute("data-rm-sibling-hidden")) {
          const orig = el.getAttribute("data-rm-sibling-orig-style") || "";
          el.setAttribute("style", orig);
          el.removeAttribute("data-rm-sibling-hidden");
          el.removeAttribute("data-rm-sibling-orig-style");
        }
        if (el.getAttribute("data-rm-parent-zeroed")) {
          const orig = el.getAttribute("data-rm-parent-orig-style") || "";
          el.setAttribute("style", orig);
          el.removeAttribute("data-rm-parent-zeroed");
          el.removeAttribute("data-rm-parent-orig-style");
        }
      } catch (e) {}
    }
    this._collapsedSiblings = [];

    // Restore documentElement
    const doc = this._mainWindow?.document;
    if (doc) {
      doc.documentElement.style.removeProperty("padding");
      doc.documentElement.style.removeProperty("margin");
    }
  }

  // -------------------------------------------------------------------------
  // XUL chrome collapsing (native attribute approach)
  // -------------------------------------------------------------------------

  /**
   * In XUL, CSS display:none does not always remove an element from the
   * layout (especially <toolbox>).  The correct approach is to set the
   * native `collapsed` and `hidden` attributes.  We also explicitly zero
   * the element's height via inline style for extra insurance and move it
   * out of flow with `position: fixed` off-screen.
   */
  _collapseXULChrome(doc) {
    const selectors = [
      "#navigator-toolbox",
      "toolbox",
      "#titlebar",
      "#toolbar-menubar",
      "#main-menubar",
      "menubar",
      "#zotero-tabs-toolbar",
      "#tab-bar-container",
    ];
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) {
        if (el.getAttribute("data-rm-xul-collapsed")) continue;
        // Save original state
        el.setAttribute("data-rm-xul-collapsed", "1");
        el.setAttribute("data-rm-xul-orig-collapsed", el.getAttribute("collapsed") || "");
        el.setAttribute("data-rm-xul-orig-hidden", el.getAttribute("hidden") || "");
        el.setAttribute("data-rm-xul-orig-style", el.getAttribute("style") || "");
        // Native XUL collapse
        el.setAttribute("collapsed", "true");
        el.setAttribute("hidden", "true");
        // Belt-and-suspenders: CSS hide + move off-screen
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "collapse", "important");
        el.style.setProperty("height", "0", "important");
        el.style.setProperty("min-height", "0", "important");
        el.style.setProperty("max-height", "0", "important");
        el.style.setProperty("overflow", "hidden", "important");
        el.style.setProperty("padding", "0", "important");
        el.style.setProperty("margin", "0", "important");
        el.style.setProperty("border", "none", "important");
        // Nuclear: move completely off-screen so even if it retains layout
        // slot, it's at -9999px and its height doesn't affect content area
        el.style.setProperty("position", "fixed", "important");
        el.style.setProperty("top", "-9999px", "important");
        el.style.setProperty("left", "-9999px", "important");
      }
    }
  }

  _restoreXULChrome(doc) {
    for (const el of doc.querySelectorAll("[data-rm-xul-collapsed]")) {
      try {
        const origCollapsed = el.getAttribute("data-rm-xul-orig-collapsed");
        const origHidden = el.getAttribute("data-rm-xul-orig-hidden");
        const origStyle = el.getAttribute("data-rm-xul-orig-style") || "";
        if (origCollapsed) {
          el.setAttribute("collapsed", origCollapsed);
        } else {
          el.removeAttribute("collapsed");
        }
        if (origHidden) {
          el.setAttribute("hidden", origHidden);
        } else {
          el.removeAttribute("hidden");
        }
        el.setAttribute("style", origStyle);
        el.removeAttribute("data-rm-xul-collapsed");
        el.removeAttribute("data-rm-xul-orig-collapsed");
        el.removeAttribute("data-rm-xul-orig-hidden");
        el.removeAttribute("data-rm-xul-orig-style");
      } catch (e) {}
    }
  }

  // -------------------------------------------------------------------------
  // PDF zoom: fit to page height
  // -------------------------------------------------------------------------

  /**
   * Try to set the reader's zoom to "page-height" so the document fills the
   * full vertical extent of the screen.
   */
  _fitPageHeight() {
    try {
      // Zotero 8 exposes a reader API via Zotero.Reader
      if (typeof Zotero === "undefined") return;

      // Get the active reader instance
      const reader = Zotero.Reader?._readers?.find(r => {
        try { return r._iframeWindow; } catch(e) { return false; }
      }) || Zotero.Reader?.getByTabID?.(Zotero.getActiveZoteroPane()?.getSelectedTabID?.());

      if (reader) {
        // Internal reader uses _iframeWindow.PDFViewerApplication or similar
        const iframeWin = reader._iframeWindow || reader._iframe?.contentWindow;
        if (iframeWin) {
          // pdf.js style API
          const pdfViewer = iframeWin.PDFViewerApplication?.pdfViewer
                         || iframeWin.wrappedJSObject?.PDFViewerApplication?.pdfViewer;
          if (pdfViewer) {
            pdfViewer.currentScaleValue = "page-height";
            return;
          }
          // Zotero's own reader API – try dispatching a zoom command
          const state = reader._state;
          if (state && typeof reader.setViewState === "function") {
            reader.setViewState({ scrollMode: state.scrollMode, spreadMode: state.spreadMode, scale: "page-height" });
            return;
          }
        }
      }
    } catch (e) {
      // Best-effort; non-critical
      if (typeof Zotero !== "undefined") {
        Zotero.debug("ReadingMode: fitPageHeight failed – " + e);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Button state synchronisation
  // -------------------------------------------------------------------------

  _syncButtonStates() {
    // Prune stale (detached from DOM) button references
    this._injectedButtons = this._injectedButtons.filter((btn) => btn.isConnected);

    const shortcut = "F11";

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
        dump("ReadingMode destroy/_deactivate error: " + e);
      }
    }

    const doc = this._mainWindow?.document;

    // Remove keyboard listener
    if (doc && this._onKeyDown) {
      doc.removeEventListener("keydown", this._onKeyDown, /* capture */ true);
      this._onKeyDown = null;
    }

    // Remove fullscreen-change listeners
    if (this._onFullscreenChange) {
      if (doc) {
        doc.removeEventListener("fullscreenchange", this._onFullscreenChange);
        doc.removeEventListener("mozfullscreenchange", this._onFullscreenChange);
      }
      if (this._mainWindow) {
        this._mainWindow.removeEventListener("sizemodechange", this._onFullscreenChange);
      }
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

    // Remove floating exit button
    this._removeFloatingExitButton();

    // Remove reader iframe styles + JS toolbar overrides
    this._removeReaderContentStyles();
    this._restoreReaderToolbarsJS();
    this._restoreCollapsedSiblings();

    // Restore XUL chrome
    if (this._mainWindow?.document) {
      this._restoreXULChrome(this._mainWindow.document);
    }

    // Remove injected <style> element
    this._removeStyles();

    // Clear the window reference last
    this._mainWindow = null;

    if (typeof Zotero !== "undefined") {
      Zotero.debug("ReadingMode: destroyed");
    }
  }
}
