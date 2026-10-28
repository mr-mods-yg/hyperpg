# HyperPG

HyperPG is a lightweight desktop client for browsing PostgreSQL databases. Paste a PostgreSQL connection URL, then explore schemas, tables, columns, and rows in a simple sidebar and table view.

## Download

The latest stable release is **[v1.0.8](https://github.com/mr-mods-yg/hyperpg/releases/tag/v1.0.8)**. Download the build for your system:

- [Windows setup installer](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-windows-amd64-setup.exe)
- [Linux x64](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-linux-amd64.tar.gz)
- [All releases, including nightly builds](https://github.com/mr-mods-yg/hyperpg/releases)

The Windows installer sets up HyperPG for the current user, adds Start Menu and desktop shortcuts, and can be removed from Windows Settings. When upgrading from v1.0.4 or older, run the installer once manually; later in-app updates open the setup wizard directly. On Linux, extract the archive and run `hyperpg`; Linux builds require GTK 4 and WebKitGTK 6.0 at runtime.

## Features

- Browse database schemas, tables, columns, and rows, and edit table data with staged, transactional saves.
- Page through table rows and choose how many rows to display.
- Run SQL scripts against the selected database and inspect statement results.
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
- Right-click a cell to add a row above or below it, duplicate, delete or restore rows, set NULL, or revert cells. New rows use PostgreSQL defaults for untouched cells. Their position is temporary: after saving, rows are ordered by primary key, or by physical location when there is no primary key.

## Running SQL scripts

Open a database and choose **New SQL script**. Type SQL, then select **Run script** or press Ctrl/Cmd+Enter. Select text to run only that portion. Results are shown for each statement, with the first 500 rows of each result displayed and available to copy as CSV. Include `COMMIT` when using an explicit transaction; an unfinished transaction is rolled back when execution ends.

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

## Release branches

- `master` is the stable line. Stable releases are created from version tags such as `v1.0.0` on commits reachable from `master`.
- `nightly` is the prerelease line. A push to `nightly` builds a prerelease immediately; the scheduled workflow also rebuilds its latest commit daily at 02:17 UTC.
- Nightly release notes include new changelog entries and linked commits since the previous nightly in that version series, with the latest stable release as the first nightly's baseline. Rebuilds of the same commit explicitly report no source changes.
- Set `master` as the GitHub repository's default branch so the scheduled workflow is enabled. Push both `master` and `nightly` to the repository.
- GitHub Actions builds a Windows setup installer and Linux x64 archive and publishes them on the release page. Linux builds require GTK 4 and WebKitGTK 6.0 at runtime.
- Choose **Stable** or **Nightly** in Settings to receive updates from that release channel. HyperPG checks for updates at launch and verifies release downloads against GitHub's SHA-256 asset digest before restarting into the update. Keep the app in a folder your user account can write to so it can update itself.

See the [changelog](CHANGELOG.md) for release history and the [release workflow](.github/workflows/release.yml) for build details.
