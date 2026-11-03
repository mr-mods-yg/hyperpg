# Focused Reset follow-up review

**Result: approved for the two Reset fixes and the companion behavior reviewed here. No remaining blockers were verified in this scope.** This recheck addresses the two findings in [the earlier follow-up review](design-audit-follow-up-review.md); it is not a new broad design audit or a recertification of earlier scores.

The recovery branch in `App.tsx` now presents the builder after a failed builder-submitted empty query when recovery columns exist. The Reset handler in `TableQueryControls.tsx` submits a fresh empty query without first overwriting the local draft, allowing a cancelled guard to preserve it. An accepted Reset updates the value and clears the draft, including when the applied query was already empty.

## Independent interactions

Using mocked database and update bindings in a separate browser context:

- Applied a filter and, in a subsequent focused run, a sort; Reset attempted an unfiltered read that failed. The empty builder remained open. An unchanged Apply made another unfiltered request; while that request was held, focus moved to the stable Data workspace and a later response did not steal focus from another control. After the retry failed, a corrected filter produced the expected filtered request. Removing the last condition and applying also attempted an unfiltered read and left the recovery builder available on failure. Reset succeeded once the mocked failure was removed.
- With applied filter `123`, a distinct local filter draft `456`, and an unsaved row edit, cancelling the guarded Reset preserved all three and made no additional read. The dialog initially focused Keep editing, wrapped keyboard focus, and returned focus to Reset on cancellation. Discard and continue removed the row edit, performed the unfiltered read, cleared the filter, and focused the Data workspace. With the applied query already empty, Reset cleared an unapplied filter draft without another read and kept focus on Reset.
- A failed Save and continue kept the row and filter drafts, made no query read, and returned focus to Reset. A subsequent successful save submitted the edited row and continued with the unfiltered Reset.
- After applying filters in two table tabs with distinct column names, a failed empty read in the first tab recovered its own columns. Switching away and back retained the second tab's filter and columns and recovered the first tab's columns again; a corrected query used the first table's column.

The earlier review's two observation tests intentionally asserted the defects. They were not run as positive product tests; the independent tests above assert the corrected behavior instead.

## Checks and evidence

The isolated Playwright server used port 9263, a temporary Vite cache, and output directories under `/tmp/hyperpg-further-design/reset-review/`. It did not use a real database, the shared browser results directory, or a user preview server. From `frontend`:

```sh
./node_modules/.bin/playwright test --config /tmp/hyperpg-further-design/reset-review/independent.config.mjs --reporter=line
./node_modules/.bin/playwright test --config /tmp/hyperpg-further-design/reset-review/permanent.config.mjs --grep 'applying filters keeps focus stable|filter apply after discarding|a rejected filter|retrying an unchanged filter|failed empty filter queries|cancelling a guarded Reset|filter recovery keeps the right columns' --reporter=line
./node_modules/.bin/playwright test --config /tmp/hyperpg-further-design/reset-review/independent.config.mjs --grep 'failed empty Reset: unchanged retry' --reporter=line
```

The independent interactions passed **4/4** (`independent.log`); the selected permanent regressions passed **7/7** (`permanent.log`). The first independent scenario was then extended to include an active sort and passed **1/1** (`independent-sort.log`). The current temporary independent spec contains that added sort check. `git diff --check` passed. The full suite and build were not rerun for this focused recheck; earlier full-suite and unit results predate these fixes.

The production fingerprint at start and end was **33 files, SHA-256 `f67df91b446611037960a7aca6fbf80f9a8bc6014c71371695b93a0ac09b910b`**, calculated over sorted repository-relative paths under `frontend/src` and `frontend/public`, with each path, NUL, file contents, and NUL fed to SHA-256. This review did not edit production or permanent test files. CSV headings, palettes, history wrapping, native desktop rendering, real database behavior, and assistive technology were outside this recheck.
