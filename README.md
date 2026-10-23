# HyperPG

HyperPG is a lightweight desktop client for browsing PostgreSQL databases. Paste a PostgreSQL connection URL, then explore schemas, tables, columns, and rows in a simple sidebar and table view.

## Download

The latest stable release is **[v1.0.7](https://github.com/mr-mods-yg/hyperpg/releases/tag/v1.0.7)**. Download the build for your system:

- [Windows setup installer](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-windows-amd64-setup.exe)
- [Linux x64](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-linux-amd64.tar.gz)
- [All releases, including nightly builds](https://github.com/mr-mods-yg/hyperpg/releases)

The Windows installer sets up HyperPG for the current user, adds Start Menu and desktop shortcuts, and can be removed from Windows Settings. When upgrading from v1.0.4 or older, run the installer once manually; later in-app updates open the setup wizard directly. On Linux, extract the archive and run `hyperpg`; Linux builds require GTK 4 and WebKitGTK 6.0 at runtime.

## Features

- Browse database schemas, tables, columns, and rows, and edit table data with staged, transactional saves.
- Page through table rows and choose how many rows to display.
- Select multiple cells and copy them as CSV.
- Add, duplicate, delete, restore, and revert rows and cells from the table context menu.
- Resize the sidebar and collapse schema groups.
- Choose Light, Cream, Dark, or Discord themes and adjust the interface font size.
- Save connection details locally in SQLite. Connection URLs are encrypted with AES-GCM, using a key held in the operating system's credential store.
- Receive stable or nightly updates in the app. HyperPG checks at launch and verifies downloaded assets with their SHA-256 digest. Windows updates open the setup wizard; Linux updates restart the app. On Linux, keep the app in a folder your account can write to.

## Update channels

Choose **Stable** or **Nightly** in Settings. Stable releases use version tags on `master`; the nightly channel tracks prereleases built from `nightly`. A new version can be installed from the in-app update alert. Windows updates use the setup installer and restart HyperPG after installation.

## Working with table data

- The sidebar groups tables under **connection → database → schema → table**. Expand a connection, database, or schema to browse it. Drag the sidebar divider to resize it; its width is saved on this device.
- Right-click a connection for **Open**, **Edit**, or **Delete**, or use the edit and delete buttons beside its name. Edit supports renaming and replacing the connection URL; leave the URL blank to keep the saved one.
- **Show all databases**, available when adding or editing a connection, lists the accessible databases on that server. When off, only the database in the connection URL is shown.

- Select cells by clicking or dragging. Shift extends a range, Ctrl/Cmd toggles individual cells, and clicking a row number selects the row. Arrow keys move the active cell; Shift+arrow extends the selection. Ctrl/Cmd+A selects the current page.
- Ctrl/Cmd+C or **Copy CSV** copies selected values as CSV with quoted commas, quotes, and line breaks. Disjoint selections retain their positions inside the selected rectangle; unselected fields and NULL values are empty. Column headers are omitted.
- Double-click a cell or press Enter/F2 to edit. Enter finishes editing, Shift+Enter inserts a line break, and Escape cancels the current cell edit. Generated columns are read-only.
- **Save changes** (Ctrl/Cmd+S) applies the draft in one transaction. **Discard changes** restores the loaded page. Navigation asks how to handle an unsaved draft.
- Right-click to add, duplicate, delete, restore, set NULL, or revert cells. New rows use PostgreSQL defaults for untouched cells.

## Build from source

You need Go 1.25, Node.js 22, and the Wails CLI `v3.0.0-beta.28`. Linux builds also need GTK 4 and WebKitGTK 6.0 development libraries.

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28
cd frontend
npm ci
cd ..
wails3 dev
```

Build a production app with:

```sh
wails3 build
```

## Releases

- `master` is the stable branch. Stable version tags such as `v1.0.0` must point to a commit on `master`. Before tagging a release, add its dated notes to `CHANGELOG.md` using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
- `nightly` is the prerelease branch. Each push creates a nightly release, and the workflow rebuilds its latest commit daily at 02:17 UTC. Set `master` as the repository's default branch so GitHub runs the scheduled workflow.
- GitHub Actions builds a Windows setup installer and Linux x64 archive and publishes them on the release page.

See the [changelog](CHANGELOG.md) for release history and the [release workflow](.github/workflows/release.yml) for build details.
