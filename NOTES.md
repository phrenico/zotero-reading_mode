## Developer Guide

### Architecture

- All logic lives in `bootstrap.js`, centered on the `ReadingMode` class.
- Lifecycle hooks: `startup`, `shutdown`, `install`, `uninstall` (Zotero/Firefox bootstrapped extension).
- `ReadingMode` manages:
	- Fullscreen activation (via HTML5 Fullscreen API and XUL window attributes)
	- Hiding Zotero chrome (side panes, toolbars, menu bar, etc.)
	- Injecting nuclear CSS and JS into reader iframes to eliminate gaps and overscroll
	- Toolbar button injection and state sync
	- Clean teardown: removes all injected DOM, listeners, and styles

### Style Injection

- `_injectReaderContentStyles()` recursively injects nuclear CSS into all reader iframes.
- Aggressive rules zero out margin, padding, overscroll, and force `#split-view` top=0.
- Direct JS sets `split-view` style properties for extra insurance.
- All style elements are tracked and removed on deactivation.

### Diagnostics

- `_dumpDiagnostics()` logs layout info to Zotero debug log (Help → Debug Output Logging → View Output).
- Includes window/fullscreen state, element positions, and reader iframe internals.
- Useful for troubleshooting persistent gaps or layout issues.

### Teardown

- On deactivation/uninstall, all DOM changes, listeners, and injected styles are removed.
- MutationObserver and toolbar buttons are fully cleaned up.

### Developer Workflow

1. Edit `bootstrap.js` and/or `manifest.json`.
2. Rebuild the XPI:
	 ```bash
	 zip -r zotero-reading-mode-1.1.0.xpi . -x '*.git*' '*.md'
	 ```
3. Install in Zotero via Tools → Add-ons → Install Add-on From File…
4. Use Zotero debug log for diagnostics.