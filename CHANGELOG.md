# Changelog

All notable changes to HyperPG are documented here. This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses Semantic Versioning.

## [Unreleased]

### Added

- Connection context menus and editing for saved names, URLs, and database visibility.
- A nested connections → databases → schemas → tables sidebar, with optional browsing of all accessible databases on a server.
- A table workspace that uses 90% of the main pane and keeps table context in the connection, database, schema, and table breadcrumbs.
- A wider, shorter Settings dialog with a single-row theme chooser.
- A cleaner table workspace without the connection and save-state footer text.
- Grid selection and keyboard hints stay hidden until there is feedback to show.
- Multi-cell selection with drag, Shift, Ctrl/Cmd, arrow keys, and CSV clipboard copying.
- Editable table cells with staged changes, Save/Discard controls, and unsaved-change navigation prompts.
- Row context menus for adding, duplicating, deleting, restoring, setting NULL, and reverting cells.
- Transactional table saves with concurrent-edit detection, including tables without primary keys and partitioned tables.
- Automated grid browser checks and PostgreSQL integration checks before publishing releases.
- GitHub release builds for Windows and Linux.
- Daily prereleases built from the `nightly` branch.
- Stable and nightly update channels, with verified in-app downloads and restart.

### Fixed

- Remove duplicate in-app branding and the green connected-status badge.
- Simplify table-view borders and remove the duplicate row range from pagination.
- Correctly detect newer nightly releases whose sequence number has the same number of digits.
- Restore sidebar resizing by preventing a fixed width from overriding the dragged width.
- Simplify sidebar table navigation to name labels without column dropdowns.
- Expand the focus border around the full cell selection, including separate ranges, without outlines around interior cells.
- Preserve exact large integers, decimal values, arrays, and binary values when reading table data.
- Display actual column nullability in the Structure view.
