# Welcome to Your New Wails3 Project!

Congratulations on generating your Wails3 application! This README will guide you through the next steps to get your project up and running.

## Getting Started

1. Navigate to your project directory in the terminal.

2. To run your application in development mode, use the following command:

   ```
   wails3 dev
   ```

   This will start your application and enable hot-reloading for both frontend and backend changes.

3. To build your application for production, use:

   ```
   wails3 build
   ```

   This will create a production-ready executable in the `build` directory.

## Exploring Wails3 Features

Now that you have your project set up, it's time to explore the features that Wails3 offers:

1. **Check out the examples**: The best way to learn is by example. Visit the `examples` directory in the `v3/examples` directory to see various sample applications.

2. **Run an example**: To run any of the examples, navigate to the example's directory and use:

   ```
   go run .
   ```

   Note: Some examples may be under development during the alpha phase.

3. **Explore the documentation**: Visit the [Wails3 documentation](https://v3.wails.io/) for in-depth guides and API references.

4. **Join the community**: Have questions or want to share your progress? Join the [Wails Discord](https://discord.gg/JDdSxwjhGf) or visit the [Wails discussions on GitHub](https://github.com/wailsapp/wails/discussions).

## Project Structure

Take a moment to familiarize yourself with your project structure:

- `frontend/`: Contains your frontend code (HTML, CSS, JavaScript/TypeScript)
- `main.go`: The entry point of your Go backend
- `app.go`: Define your application structure and methods here
- `wails.json`: Configuration file for your Wails project

## Next Steps

1. Modify the frontend in the `frontend/` directory to create your desired UI.
2. Add backend functionality in `main.go`.
3. Use `wails3 dev` to see your changes in real-time.
4. When ready, build your application with `wails3 build`.

Happy coding with Wails3! If you encounter any issues or have questions, don't hesitate to consult the documentation or reach out to the Wails community.

## Changelog

Notable changes are tracked in [CHANGELOG.md](CHANGELOG.md), using the [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) format and Semantic Versioning.

## Working with table data

- The sidebar groups tables under **connection → database → schema → table**. Expand a connection, database, or schema to browse it. Drag the sidebar divider to resize it; its width is saved on this device.
- Right-click a connection for **Open**, **Edit**, or **Delete**, or use the edit and delete buttons beside its name. Edit supports renaming and replacing the connection URL; leave the URL blank to keep the saved one.
- **Show all databases**, available when adding or editing a connection, lists the accessible databases on that server. When off, only the database in the connection URL is shown.

- Select cells by clicking or dragging. Shift extends a range, Ctrl/Cmd toggles individual cells, and clicking a row number selects the row. Arrow keys move the active cell; Shift+arrow extends the selection. Ctrl/Cmd+A selects the current page.
- Ctrl/Cmd+C or **Copy CSV** copies selected values as CSV with quoted commas, quotes, and line breaks. Disjoint selections retain their positions inside the selected rectangle; unselected fields and NULL values are empty. Column headers are omitted.
- Double-click a cell or press Enter/F2 to edit. Enter finishes editing, Shift+Enter inserts a line break, and Escape cancels the current cell edit. Generated columns are read-only.
- **Save changes** (Ctrl/Cmd+S) applies the draft in one transaction. **Discard changes** restores the loaded page. Changes stay local until saved, and navigation asks how to handle an unsaved draft. A save failure keeps the draft available for correction.
- Right-click for **Add row**, **Duplicate row**, **Delete row**, **Restore deleted rows**, **Set NULL**, and **Revert cell**. Deletion applies to all rows containing selected cells. New rows use PostgreSQL defaults for untouched cells. Duplicates copy editable values and let PostgreSQL generate identity/sequence values again.
- Saves check the original row version, including tables without primary keys. If another session changes a row, the entire save rolls back; discard and refresh to load its latest value.

## Validation

Run `npm ci`, `npm test`, and `npm run build` in `frontend`. Install the browser once with `npx playwright install chromium`, then run `npm run test:e2e` for grid and clipboard interaction checks. Browser tests replace the desktop IPC boundary with test fixtures.

Set `HYPERPG_TEST_DATABASE_URL` to a disposable PostgreSQL database and run `go test -tags server ./...` after building the frontend. Integration tests create and remove their own schemas and cover exact values, mixed saves, rollback, concurrent changes, and duplicate/partitioned rows. Without the variable, PostgreSQL integration tests are skipped. The release workflow runs both suites against PostgreSQL before building release assets.

## Release branches

- `master` is the stable line. Stable releases are created from version tags such as `v1.0.0` on commits reachable from `master`.
- `nightly` is the prerelease line. A push to `nightly` builds a prerelease immediately; the scheduled workflow also rebuilds its latest commit daily at 02:17 UTC.
- Nightly release notes include new changelog entries and linked commits since the previous nightly in that version series, with the latest stable release as the first nightly's baseline. Rebuilds of the same commit explicitly report no source changes.
- Set `master` as the GitHub repository's default branch so the scheduled workflow is enabled. Push both `master` and `nightly` to the repository.
- Each release includes a Windows executable and a Linux `tar.gz` containing the Linux executable. Linux requires GTK 4 and WebKitGTK 6.0 at runtime.
- Choose **Stable** or **Nightly** in Settings to receive updates from that release channel. HyperPG checks for updates at launch and verifies release downloads against GitHub's SHA-256 asset digest before restarting into the update. Keep the app in a folder your user account can write to so it can update itself.

To publish the initial branches after committing the release setup on `master`:

```sh
git push -u origin master
git switch nightly
git merge master
git push -u origin nightly
git switch master
```

Before creating a stable tag, move the corresponding changes from `[Unreleased]` into a dated version section in `CHANGELOG.md`, then push the tag:

```sh
git switch master
git tag -a v1.0.0 -m "hyperpg v1.0.0"
git push origin master
git push origin v1.0.0
```

The release workflow checks that the tag points to `master` and uses that version's changelog section as the GitHub release notes.
