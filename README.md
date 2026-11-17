# HyperPG

HyperPG is a lightweight desktop client for browsing PostgreSQL databases. Paste a PostgreSQL connection URL, then explore schemas, tables, columns, and rows in a simple sidebar and table view.

## Download

The latest stable release is **[v1.0.12](https://github.com/mr-mods-yg/hyperpg/releases/tag/v1.0.12)**. Download the build for your system:

- [Windows setup installer](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-windows-amd64-setup.exe)
- [Linux x64](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-linux-amd64.tar.gz)
- [All releases, including nightly builds](https://github.com/mr-mods-yg/hyperpg/releases)

The Windows installer sets up HyperPG for the current user, adds Start Menu and desktop shortcuts, and can be removed from Windows Settings. When upgrading from v1.0.4 or older, run the installer once manually; later in-app updates open the setup wizard directly. On Linux, extract the archive and run `hyperpg`; Linux builds require GTK 4 and WebKitGTK 6.0 at runtime.

## Features

- Browse database schemas, tables, columns, and rows, and edit table data with staged, transactional saves.
- Page through table rows and choose how many rows to display.
- Write SQL with highlighting, line numbers, schema autocomplete, formatting, and current-statement execution.
- Save and open SQL files, rename scripts, and restore tabs and drafts after restart.
- Search query history and reopen earlier queries in a new tab.
- Filter table rows in PostgreSQL, sort columns, and inspect keys, indexes, constraints, and generated SQL.
- Export loaded or selected rows to CSV, JSON, or SQL files, or stream all rows matching the filters to a file.
- Right-click a database and choose **Export to Excel…** to save its tables as an .xlsx workbook: one sheet per table, named after it, with a header row of column names, typed numbers, dates and booleans, and a summary sheet. Choose schemas and tables (and optionally views); all sheets come from one consistent read-only snapshot, with progress and cancel.
- Copy a single cell's value, or select multiple cells and copy them as CSV, with or without column headers.
- Add, duplicate, delete, restore, and revert rows and cells from the table context menu.
- Resize the sidebar and collapse schema groups.
- Choose Light, Cream, Dark, or Discord themes and adjust the interface font size.
- Save connection details locally in SQLite. Connection URLs are encrypted with AES-GCM, using a key held in the operating system's credential store.
- Receive stable or nightly updates in the app. HyperPG checks at launch and verifies downloaded assets with their SHA-256 digest. Windows updates open the setup wizard; Linux updates restart the app. On Linux, keep the app in a folder your account can write to.

## Update channels

Choose **Stable** or **Nightly** in Settings. Stable releases use version tags on `master`; the nightly channel tracks prereleases built from `nightly`. A new version can be installed from the in-app update alert. Windows updates use the setup installer and restart HyperPG after installation.

## Working with table data

- The sidebar groups tables under **connection → database → schema → table**. Expand a connection, database, or schema to browse it. Drag the sidebar divider to resize it; its width is saved on this device.
- Right-click a connection for **Open**, **Edit**, or **Delete**, or use the edit and delete buttons beside its name. Deleting asks for confirmation first. Edit supports renaming and replacing the connection URL; leave the URL blank to keep the saved one.
- The sidebar tree works from the keyboard: arrow keys move and expand, Home and End jump, typing finds an item, F2 edits a connection, and Delete removes it after confirmation.
- **Show all databases**, available when adding or editing a connection, lists the accessible databases on that server. When off, only the database in the connection URL is shown.

- Select cells by clicking or dragging. Shift extends a range, Ctrl/Cmd toggles individual cells, and clicking a row number selects the row. Arrow keys move the active cell; Shift+arrow extends the selection. Ctrl/Cmd+A selects the current page.
- Ctrl/Cmd+C or **Copy CSV** copies a single selected cell as its raw value, and several cells as CSV with quoted commas, quotes, and line breaks. Disjoint selections retain their positions inside the selected rectangle; unselected fields and NULL values are empty. Column headers are omitted; choose **Copy with headers** in the cell menu to include them.
- Double-click a cell or press Enter/F2 to edit. Enter finishes editing, Shift+Enter inserts a line break, and Escape cancels the current cell edit. Generated columns are read-only.
- **Save changes** (Ctrl/Cmd+S) applies the draft in one transaction, and the grid stays on the same cell while the page refreshes. **Discard changes** restores the loaded page and can be undone. Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo draft edits, and Delete sets the selected cells to NULL. Navigation, and closing the window, ask how to handle an unsaved draft.
- Paging, sorting, and filtering keep the current rows visible (read-only) until the next page arrives. Clicking a column header a third time clears its sort.
- Right-click a cell to add a row above or below it, duplicate, delete or restore rows, set NULL, or revert cells. New rows use PostgreSQL defaults for untouched cells. Their position is temporary: after saving, rows are ordered by primary key, or by physical location when there is no primary key.

## Running SQL scripts

Open a database and choose **New SQL script**. Type SQL, then select **Run script** (Ctrl/Cmd+Shift+Enter). Select text to run only that portion, or choose **Run statement** (Ctrl/Cmd+Enter) to run the statement at the cursor. While a query runs, **Cancel** or Escape stops it in PostgreSQL. When a statement fails, the editor marks it and the results say which statements ran, were rolled back, or were skipped. **Format** formats the script. Table and column suggestions use the active database schema. Results are shown for each statement, with the first 500 rows of each result displayed and available to copy as CSV. Use **Open SQL**, **Save SQL**, and **Rename** to manage script files; closing a script with unsaved edits offers **Save** or **Don't save**. Drafts and open tabs are stored locally and restored using the original connection and database. **Query history** records SQL, database, timing, and failure messages; entries can be reopened, and clearing the history can be undone.

Use **Export** to save loaded results. SQL results remain limited to the displayed first 500 rows; **All rows matching filters** in a table tab streams all matching saved rows directly from PostgreSQL. JSON preserves exact numeric values as strings. SQL exports omit computed columns and preserve identity values.

Tabs show a dot when a script or table has unsaved changes. Middle-click a tab or press Delete on it to close it, and right-click it for **Close others**, **Close to the right**, and **Close all**. When tabs no longer fit, **Show all tabs** lists every open tab.

Table headers sort in PostgreSQL; **Filters** applies conditions across the table, while **Search this page** searches only loaded rows. **Structure** shows constraints and indexes and can generate SQL in a new script tab. Generated DDL includes columns, constraints, and independent indexes, and labels omitted PostgreSQL table properties; it is not a full schema backup.

Include `COMMIT` when using an explicit transaction; an unfinished transaction is rolled back when execution ends.

## Project layout

- `main.go` boots the desktop app and embeds its assets and version.
- `internal/database/` contains PostgreSQL services, local connection storage, file operations, and their tests.
- `internal/updates/` contains release checks and platform update helpers.
- `frontend/` contains the React interface and generated Wails bindings.
- `scripts/release/` contains release-note generation and its tests.
- `build/` contains platform packaging and task definitions.

## Build from source

You need Go 1.25, Node.js 22, and the Wails CLI `v3.0.0-beta.28`. Linux builds also need GTK 4 and WebKitGTK 6.0 development libraries.

Install the frontend dependencies and run the app in development mode:

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28
cd frontend
npm ci
cd ..
wails3 dev
```

Build a production app with `wails3 build`.

Run `npm test` and `npm run build` in `frontend`. Install the browser once with `npx playwright install chromium`, then run `npm run test:e2e` for grid and clipboard interaction checks. Browser tests replace the desktop IPC boundary with test fixtures.

Set `HYPERPG_TEST_DATABASE_URL` to a disposable PostgreSQL database and run `go test -tags server ./...` after building the frontend. Integration tests create and remove their own schemas and cover exact values, mixed saves, rollback, concurrent changes, and duplicate/partitioned rows. Without the variable, PostgreSQL integration tests are skipped. The release workflow runs both suites against PostgreSQL before building release assets.

Configure action shortcuts in Settings. Refresh defaults to F5, closing the active tab to Ctrl+W, and saving to Ctrl+S; other actions are unassigned. On macOS, Ctrl in these shortcuts means Cmd. Settings also lists the built-in shortcuts: Ctrl/Cmd+Enter and Ctrl/Cmd+Shift+Enter in the SQL editor, Escape to cancel a query, and Ctrl+Tab or Ctrl+Shift+Tab (also Ctrl+PageDown and Ctrl+PageUp) to switch tabs.

## Release branches

- `master` is the stable line. Stable releases are created from version tags such as `v1.0.0` on commits reachable from `master`.
- `nightly` is the prerelease line. A push to `nightly` builds a prerelease immediately; the scheduled workflow also rebuilds its latest commit daily at 02:17 UTC.
- Nightly release notes include new changelog entries and linked commits since the previous nightly in that version series, with the latest stable release as the first nightly's baseline. Rebuilds of the same commit explicitly report no source changes.
- Set `master` as the GitHub repository's default branch so the scheduled workflow is enabled. Push both `master` and `nightly` to the repository.
- GitHub Actions builds a Windows setup installer and Linux x64 archive and publishes them on the release page. Linux builds require GTK 4 and WebKitGTK 6.0 at runtime.
- Choose **Stable** or **Nightly** in Settings to receive updates from that release channel. HyperPG checks for updates at launch and verifies release downloads against GitHub's SHA-256 asset digest before restarting into the update. Keep the app in a folder your user account can write to so it can update itself.

See the [changelog](CHANGELOG.md) for release history and the [release workflow](.github/workflows/release.yml) for build details.
