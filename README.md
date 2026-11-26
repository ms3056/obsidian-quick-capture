# Quick Capture

A standalone Quick Capture window for Obsidian, opened from a global desktop hotkey. Capture text into tasks, Inbox notes, daily notes, journal, gratitude, or wins without leaving what you are doing.

## Features

- True standalone OS window with a configurable global shortcut (default `Alt + Space`).
- Six capture destinations: **Task**, **Inbox**, **Daily**, **Journal**, **Gratitude**, and **Win**.
- Switch destinations with the bottom button, `Tab` / `Shift+Tab`, or `Ctrl/Cmd + 0/J/G/W/I/T`.
- Task capture supports due date, start date, six priority levels, `| description` detail text, and Tasks-plugin-style Markdown syntax.
- Edit existing tasks in place from the cursor command or the injected edit button in tasklist notes. **Edit Task** mode is locked to Task editing only.
- **Send to Inbox** editor command captures the current selection without deleting it on failure.
- Attach files/images by button, paste, or drag and drop.
- Optional task organization, normalization, auto-tag, created-date insertion, and completed-task purge.
- Auto-detect common vault files and headings on startup.

## Usage / Requirements

Desktop Obsidian is required because the plugin opens an independent Electron window and registers a global hotkey. Set or record your shortcut under **Settings → Quick Capture → Global Shortcut**, then press it or run **Quick Capture: Open Quick Capture**. `Enter` (or `Ctrl/Cmd + Enter` if configured) saves; `Escape` closes. Task lines use standard Obsidian Tasks Markdown syntax, including date and priority emojis.

## Installation

### Install with BRAT (recommended)

1. Install and enable **BRAT** (`Obsidian42 - BRAT`) from **Settings → Community plugins → Browse**.
2. Open the Command Palette (`Cmd/Ctrl + P`) and run **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/ms3056/obsidian-quick-capture`.
4. Leave the version on **Latest version** and click **Add Plugin**.
5. Go to **Settings → Community plugins**, refresh if needed, and enable **Quick Capture**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` (if present) from the [latest GitHub release](https://github.com/ms3056/obsidian-quick-capture/releases), copy them into `<Vault>/.obsidian/plugins/obsidian-quick-capture/`, then enable **Quick Capture** in **Settings → Community plugins**.

## License & Attribution

This plugin is licensed under the [MIT License](./LICENSE). The original upstream project is [obsidian-quick-tray](https://github.com/GOODJINC/obsidian-quick-tray) by GOODJINC (MIT); the standalone window also uses Lucide icons (ISC / Feather MIT). See [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) for the full third-party notices.
