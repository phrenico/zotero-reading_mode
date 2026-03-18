# Zotero Reading Mode

A lightweight Zotero 8 plugin that adds a **true fullscreen reading mode** for the built-in PDF viewer. It hides *everything* — window title bar, menu bar, tab bar, annotation toolbar, side panes — and enters OS-level fullscreen so you can focus entirely on your document.

## Features

- **True fullscreen** – hides the OS window title bar, Zotero menu bar, tab bar, annotation toolbar, side panes, and all other chrome. Only the PDF remains.
- **Keyboard shortcut** – `F11` to toggle (all platforms).


## Compatibility

| Zotero Version | Supported |
|----------------|-----------|
| Zotero 7.x     | Yes       |
| Zotero 8.x     | Yes       |
| Zotero 6.x     | No        |

Built as a **bootstrapped extension** using `manifest_version: 2`, targeting Firefox ESR 115+ (Zotero 7/8 engine).

## Installation

1. Download the latest `fs.xpi` from the [Releases](https://github.com/phrenico/zotero-reading_mode/releases) page (or build it yourself — see below).
2. In Zotero, go to **Tools → Plugins**.
3. Click the gear icon and choose **Install Add-on From File…**
4. Select the downloaded `zotero-reading-mode-X.Y.Z.xpi` file.
5. Restart Zotero if prompted.

## Usage

- Press `F11` while viewing a PDF to enter/exit reading mode.
- Press `Esc` to exit fullscreen (the plugin detects this and cleanly rolls back).

## Building from Source

Prerequisites: `zip` command-line tool.


```bash
# Clone the repository
git clone https://github.com/phrenico/zotero-reading_mode.git
cd zotero-reading_mode

# Build the XPI
zip -r zotero-reading-mode-X.Y.Z.xpi manifest.json bootstrap.js chrome/
```

## Project Structure

```
├── manifest.json          # Extension manifest (Zotero 8 / Firefox ESR 115)
├── bootstrap.js           # All plugin logic (lifecycle hooks + ReadingMode class)
├── chrome/
│   └── skin/
│       └── default/
│           └── icon.svg   # Plugin icon (48×48 SVG)
├── zotero-reading-mode-X.Y.Z.xpi                 # Built extension package
└── README.md
```



## Disclaimer & License

This plugin was tested only on **Ubuntu 24.04.4 LTS** using Zotero 8.0.2. It may not work as expected on other operating systems or configurations.

**No warranty is provided. Use at your own risk.**

See the [LICENSE](LICENSE) file for the full MIT license.
