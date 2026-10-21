# Changelog

All notable changes to HyperPG are documented here. This changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses Semantic Versioning.

## [Unreleased]

### Added

- Multi-cell selection with drag, Shift, Ctrl/Cmd, arrow keys, and CSV clipboard copying.
- Editable table cells with staged changes, Save/Discard controls, and unsaved-change navigation prompts.
- Row context menus for adding, duplicating, deleting, restoring, setting NULL, and reverting cells.
- Transactional table saves with concurrent-edit detection, including tables without primary keys and partitioned tables.
- Automated grid browser checks and PostgreSQL integration checks before publishing releases.
- GitHub release builds for Windows and Linux.
- Daily prereleases built from the `nightly` branch.
- Stable and nightly update channels, with verified in-app downloads and restart.

### Fixed

- Expand the focus border around the full cell selection, including separate ranges, without outlines around interior cells.
- Preserve exact large integers, decimal values, arrays, and binary values when reading table data.
- Display actual column nullability in the Structure view.
