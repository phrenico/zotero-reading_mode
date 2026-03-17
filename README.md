# Zotero Reading Mode

A lightweight Zotero 8 plugin that adds a **true fullscreen reading mode** for the built-in PDF viewer. It hides *everything* — window title bar, menu bar, tab bar, annotation toolbar, side panes — and enters OS-level fullscreen so you can focus entirely on your document.

## Features

- **True fullscreen** – hides the OS window title bar, Zotero menu bar, tab bar, annotation toolbar, side panes, and all other chrome. Only the PDF remains.
- **Keyboard shortcut** – `F11` to toggle (all platforms).
- **Toolbar button** – a toggle button is automatically injected into every open reader toolbar.
- **Floating exit hint** – a subtle exit button appears in the top-right corner on hover.
- **Clean teardown** – all DOM modifications, event listeners, and observers are fully removed on deactivation/uninstall.

## Compatibility

| Zotero Version | Supported |
|----------------|-----------|
| Zotero 7.x     | Yes       |
| Zotero 8.x     | Yes       |
| Zotero 6.x     | No        |

Built as a **bootstrapped extension** using `manifest_version: 2`, targeting Firefox ESR 115+ (Zotero 7/8 engine).

## Installation

1. Download the latest `fs.xpi` from the [Releases](https://github.com/phrenico/zotero-reading_mode/releases) page (or build it yourself — see below).
2. In Zotero, go to **Tools → Add-ons**.
3. Click the gear icon and choose **Install Add-on From File…**
4. Select the downloaded `fs.xpi` file.
5. Restart Zotero if prompted.

## Usage

- Press `F11` while viewing a PDF to enter/exit reading mode.
- Alternatively, click the fullscreen toggle button (⛶) in the reader toolbar.
- Press `Esc` to exit fullscreen (the plugin detects this and cleanly rolls back).
- A small exit button appears in the top-right corner when you move the mouse there.

## Building from Source

Prerequisites: `zip` command-line tool.

```bash
# Clone the repository
git clone https://github.com/phrenico/zotero-reading_mode.git
cd zotero-reading_mode

# Build the XPI
zip -r fs.xpi manifest.json bootstrap.js chrome/
```

## Project Structure

```
├── manifest.json          # Extension manifest (Zotero 8 / Firefox ESR 115)
├── bootstrap.js           # All plugin logic (lifecycle hooks + ReadingMode class)
├── chrome/
│   └── skin/
│       └── default/
│           └── icon.svg   # Plugin icon (48×48 SVG)
├── fs.xpi                 # Built extension package
└── README.md
```

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

## License

## License

MIT
