# Changelog

All notable changes to HyperPG are documented here. This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses Semantic Versioning.

## [Unreleased]

## [1.0.4] - 2026-10-21

### Fixed

- Show a Windows update progress window with visible errors if installation fails.
- Keep the progress window open while the installer runs, then close it after HyperPG restarts.

### Upgrade note

- When updating from v1.0.3 or older, run the v1.0.4 setup installer once manually to replace the older hidden updater helper. Later in-app updates show the progress window.

## [1.0.3] - 2026-10-21

### Added

- Multi-cell selection with drag, Shift, Ctrl/Cmd, arrow keys, and CSV clipboard copying.
- Editable table cells with staged changes, Save/Discard controls, and unsaved-change navigation prompts.
- Row context menus for adding, duplicating, deleting, restoring, setting NULL, and reverting cells.
- Transactional table saves with concurrent-edit detection, including tables without primary keys and partitioned tables.
- Per-user Windows setup installer used for installation and in-app updates.

### Fixed

- Expand the focus border across selected cells, including separate ranges, without outlining interior cells.
- Simplify sidebar table navigation to name labels without column dropdowns.
- Preserve exact large integers, decimal values, arrays, and binary values when reading table data.
- Display actual column nullability in the Structure view.
- Install Windows updates reliably, restart the app, and roll back to the previous executable if installation fails.

## [1.0.2] - 2026-10-19

### Added

- Horizontally scrollable full values for selected table cells.
- Focus highlighting and Ctrl+A selection scoped to the focused cell's value.

### Fixed

- Replaced the Windows updater's hidden PowerShell command with a native helper process.

## [1.0.1] - 2026-10-19

### Added

- Windows setup installer with Start Menu and desktop shortcuts, alongside the portable executable.

## [1.0.0] - 2026-10-19

### Added

- Read-only PostgreSQL browser for browsing schemas, tables, columns, and paginated rows.
- Local SQLite storage for saved database connections, encrypted with a key stored in the operating system credential store.
- Resizable and collapsible schema navigation, light and dark themes, and configurable rows per page.
- GitHub release builds for Windows and Linux.
- Daily prereleases built from the `nightly` branch.
- Stable and nightly update channels, with SHA-256 verified in-app downloads and restart.
