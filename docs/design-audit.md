# HyperPG design-engineering audit

## Current outcome — target reached

After five implementation and independent review rounds, **all seven design categories score 9/10** under the fixed rubric below. The [final independent Terra Max review](design-audit-independent-round-5.md) found no verified material blockers in the inspected current and carried states. Colors, typography, navigation, spacing, shared controls, keyboard behavior and responsive layouts each reached the target. [Machine-readable scores](design-scores.json) retain every independent round; [the scorecard](design-scorecard.html) compares the baseline and final result.

The final production source matches the independent review's 33-file fingerprint **`5a8275901bb941d43e27a613c758c43bd48dd82f7d3b501585cf77137d46532c`**. The production build, full **74/74** browser suite and diff check pass. The final independent selection passed **12/12**, independent scenarios **14/14**, and corrected large-text/exact-boundary follow-up **3/3**. Earlier functional helper tests passed **12/12**, and those helper sources remain unchanged. Verification used mocked bindings; these are scoped design judgments, not native-platform or assistive-technology certification.

## Rubric and scope

Scores are design judgments for the inspected states, not objective certification. Anchors: **1–3** means core workflows are difficult to use; **4–6** means usable but with substantial friction or inconsistency; **7–8** means a sound foundation with specific material issues; **9** means polished and consistent across inspected states, accessible critical controls, and no verified material issue; **10** means exceptional execution with no meaningful refinements apparent in the inspected scope. The same anchors apply before and after each round.

Rendered with Playwright and mocked Wails/database bindings (no real database): table data, SQL editor with results, Settings, and new-connection dialog at 1280×900 in Light, Dark, Cream, and Discord; the same core states at 390×600 with the 18 px font setting in Light and Dark. Screenshots disable animations. Evidence is under `/tmp/hyperpg-design-audit/`; screenshots are local, ephemeral artifacts. This is a targeted audit, not an exhaustive screen-reader, contrast, device, or application-wide certification.

## Baseline — before edits

| Category | Score | Findings from rendered states |
| --- | ---: | --- |
| Colors and contrast | 8 | Light and Dark workspaces have restrained neutral accents and legible primary text; the Dark connection security note retains a green surface inconsistent with the selected neutral theme. Secondary metadata and disabled controls are subdued, especially at compact sizes. |
| Typography and readability | 7 | Table and database names are distinct and the 18 px setting scales much of the interface. Default sidebar host, schema metadata, grid types and status labels are very small; the 18 px Settings value wraps `18 px` onto two lines. |
| Visual hierarchy and navigation | 8 | Workspace title, tabs, and SQL primary action are clear. Narrow Settings category navigation clips the next item without an obvious indication; after closing Settings on mobile the navigation scrim remains over the workspace. |
| Spacing, alignment, and density | 7 | Desktop tables and editor align cleanly. At 390×600 and 18 px, stacked global and workspace controls consume most of the viewport; the connection dialog action row overflows and clips Cancel on the left. |
| Shared components and interaction states | 8 | Shared buttons create a coherent desktop control language. Connection close target is noticeably smaller than the 40 px Settings close target; large-text dialog actions do not adapt to available width. |
| Accessibility and keyboard behavior | 7 | Critical dialogs expose names and focus handling, but the clipped dialog action can be difficult to reach visually and the mobile overlay persists after the Settings task. More keyboard verification is needed after changes. |
| Responsive and large-text layouts | 6 | The 390×600/18 px table initially shows only the top of the grid; SQL controls push results below the fold. The connection dialog clips an action and Settings wraps its font-size value. Horizontal table scrolling is expected for data columns, but primary actions should remain reachable. |

An independent baseline reviewer separately scored colors 7, typography 7, hierarchy 7, spacing 6.5, controls 6.5, accessibility 6, and responsive 4.5 under the same rubric. Their concrete additional findings were low Light muted-text contrast on paper/grid headers and the loss of a visible grid-cell focus indicator after Escape clears the selection. Those are included in this round. A reported expanded-SQL focus issue was checked against the existing implementation and browser test: the source is already made inert and restored; it is not counted as a defect. The initial screenshot showing Settings translucency was captured during animation; animation-disabled captures show an opaque surface.

Baseline evidence: `/tmp/hyperpg-design-audit/baseline/light-table.png`, `dark-sql.png`, `dark-connection.png`, `light-narrow-table.png`, `light-narrow-sql.png`, `light-narrow-connection.png`, and `dark-narrow-settings.png`; equivalent desktop captures exist for all four themes and narrow captures for Light/Dark. The capture fixture completed 6/6 scenarios after correcting the capture sequence to close the mobile navigation scrim explicitly.

## Round 1 — implementation and reassessment

Changes respond to the baseline and independent observations: darker Light and Cream muted text, neutral Dark dialog note, slightly larger small metadata, full-name hover titles in the tree, and a focus outline that persists on the active grid cell after Escape clears selection. Dialog actions now wrap, the connection close target is 40 px, the Settings value stays on one line and its mobile categories wrap, and mobile Settings returns focus to the navigation trigger after closing. Short/narrow table layouts reserve space for rows and wrap pagination; short SQL layouts give the editor and results nonzero space in a scrollable workspace. Existing expanded-results inert and focus-restoration behavior remains in place. The edits retain the theme choices, type hierarchy and shared Button ownership.

The rendered pass used the same mocked scenarios and viewports as baseline, plus a long-name desktop tree and scrolled/focused narrow states. A direct calculation from rendered text/background colors for grid column types and workspace metadata respectively gave Light **4.83:1 / 5.23:1**, Dark **6.14:1 / 7.31:1**, Cream **4.70:1 / 5.32:1**, and Discord **7.26:1 / 6.48:1**. This is a sample, not a comprehensive contrast audit. Existing browser checks also exercise enabled primary SQL control contrast in all four themes.

| Category | Baseline (implementation) | Round 1 | Reassessment |
| --- | ---: | ---: | --- |
| Colors and contrast | 8 | 8.5 | Sampled metadata meets 4.5:1 in all four themes and the Dark note is neutral; other surfaces and states have not been exhaustively measured. |
| Typography and readability | 7 | 8 | Grid types, host, and workspace metadata are larger; Settings no longer breaks its value. Several default secondary labels remain compact. |
| Visual hierarchy and navigation | 8 | 8 | Categories are visible on narrow Settings and the mobile drawer closes with sensible focus return; at large text the workspace actions still dominate the first view. Long tree names truncate with their full names available by hover and accessible label. |
| Spacing, alignment, and density | 7 | 7.5 | Dialog and pagination no longer overflow horizontally and grid controls no longer overlap rows. At 390×600/18 px, global and workspace toolbars consume too much of the working area on initial display. |
| Shared components and interaction states | 8 | 8.5 | Shared Button continues to own button appearance; wrapped actions and larger dialog close target are usable. Full interaction-state coverage across every panel remains outside this pass. |
| Accessibility and keyboard behavior | 7 | 8 | Escape, arrows and Tab retain a visible grid focus indicator; dialog actions, Settings focus return, and SQL expanded-results inert/restoration were exercised. This is not a complete assistive-technology audit. |
| Responsive and large-text layouts | 6 | 7 | Rows and SQL results are now reachable by scrolling instead of collapsing to unusable heights. At 390×600/18 px, the initial table view still shows no data rows and SQL shows only a small editor portion; the expanded results view is also constrained. A further layout/consolidation round is needed before a 9. |

Evidence: `/tmp/hyperpg-design-audit/round-1/light-table.png`, `dark-sql.png`, `cream-table.png`, `discord-sql.png`, `dark-connection.png`, `light-long-names.png`, `light-narrow-table.png`, `light-narrow-table-rows.png`, `light-narrow-sql.png`, `light-narrow-sql-results.png`, `light-narrow-sql-expanded.png`, `light-narrow-connection.png`, and `dark-narrow-settings.png` (with Light/Dark equivalents where captured). The narrow row screenshot shows the focus outline after Escape; the scrolled results screenshot demonstrates reachability, not a claim that the initial viewport is sufficiently dense.

Verification: `npm run build` passed; `npm test` passed **12/12**; the full `npx playwright test --reporter=line` suite passed **61/61**. Five new focused browser scenarios cover grid focus after Escape/arrow/Tab, narrow table rows and pagination, narrow connection actions, short SQL results/inert/focus restoration, and mobile Settings navigation/focus. The rendered capture run passed **6/6** theme/viewport scenarios; the additional long-name and Cream contrast recaptures passed **1/1** each. No real database or user data was accessed. Screenshots in `/tmp` are ephemeral.

Remaining review focus: reduce the 390×600/18 px initial control footprint while retaining the available workflows; reassess the expanded SQL results at that size; measure other text and interaction states and test with assistive technology before treating the scores as accessibility certification. Viewports below 600 px tall and native desktop rendering were not inspected in this pass.

### Independent Round 1 review

The independent reviewer scored colors **8**, typography **7.5**, hierarchy **7.5**, spacing **6.5**, shared controls **7.5**, accessibility **7.5**, and responsive layouts **6**. These are separate judgments under the same rubric; they do not replace the implementation scores above. The reviewer identified the following remaining blockers for the next round:

- Narrow toolbars leave too little useful workspace visible initially.
- Expanded SQL results can be clipped within the scrolled narrow workspace, with neither a complete result row nor the restore control visible; the existing inert behavior was confirmed and must be preserved.
- At 390×600 with 18 px text, the primary Connect database action starts below the visible part of the dialog, even though it is reachable by scrolling.
- Meaningful empty-value dashes in Structure use `--quiet`; the reviewer measured approximately **2.58:1** in Light and **2.71:1** in Cream.

These findings remain open for the next implementation and independent audit. This pass makes no claim that all categories have reached 9/10.

## Round 2 — implementation reassessment

The action layout now responds to the width of the main pane, including a resized sidebar. New SQL stays visible; Open SQL, Query history and Add connection share a Workspace actions disclosure. File options, Editor actions and Table actions use the same disclosure component, with the desktop controls still exposed directly. The table's Filters control shares the grid toolbar, and compact pagination retains named, titled controls. The selected database remains visible beside the SQL editor heading, with the full name available on truncation. No font-size setting is reduced. At 390×600/18 px the inspected table shows several initial data rows; the SQL view initially shows an editable pane, Results heading and expand control. The expanded view shows result rows and export controls without depending on the scroll offset of the editor workspace.

Expanded results render in the available workspace rectangle outside the scrolling ancestor; the existing source inert behavior remains. Opening any application dialog collapses the expanded view without moving focus out of the dialog. Disclosure commands return focus to their trigger when they do not intentionally move it elsewhere, and dialogs opened from a disclosure return to its visible trigger. The connection form keeps its actions visible while its body scrolls, including while connecting or displaying an error. Structure's empty markers use the readable muted text token, and the short Structure view no longer collapses its column table to zero height.

| Category | Round 1 independent | Round 2 implementation | Reassessment within inspected scope |
| --- | ---: | ---: | --- |
| Colors and contrast | 8 | 9 | Actual Structure absence markers, structure count and identity metadata, plus connection hint/option/note text, pass 4.5:1 in each theme in rendered tests. This is a sample, not a complete color audit. |
| Typography and readability | 7.5 | 8.5 | The 18 px setting is retained in the compact and expanded views, the database name remains visible, and long names retain full accessible text and titles. Some default-size secondary metadata remains small and deserves independent judgment. |
| Visual hierarchy and navigation | 7.5 | 9 | The table and SQL work areas regain visual priority; primary actions and the current SQL database stay visible, and secondary commands have named disclosure triggers. |
| Spacing, alignment, and density | 6.5 | 9 | The initial narrow table displays multiple rows, SQL has an editor and visible results control, and the dialog actions fit together. Compact pagination no longer needs a third row in the inspected sizes. |
| Shared components and interaction states | 7.5 | 9 | One action disclosure handles the narrow toolbar groups; buttons retain component-owned styling. Focus return, disabled commands, export, error and busy states have targeted checks. |
| Accessibility and keyboard behavior | 7.5 | 8.5 | Tab, Escape, outside focus/click, command focus, dialog focus return, results inertness and hit targets are exercised. Screen-reader and native desktop behavior remain unverified; this score is provisional rather than a certification. |
| Responsive and large-text layouts | 6 | 9 | The inspected 390×600 large-text layouts, default narrow layout, short desktop and tablet preserve initial working content and access to secondary controls. Wider tables and Structure still use horizontal scrolling for their columns. |

These are implementation judgments under the unchanged rubric, not an independent Round 2 review. In particular, typography and accessibility remain below 9 in this assessment; a fresh independent review is required before claiming the seven-category goal has been met.

Rendered evidence: `/tmp/hyperpg-design-audit/round-2/` has table, Structure, SQL, Settings and connection-dialog captures in all four themes at 1280×900; Light/Dark at 390×600 with 18 px text; a default-font narrow pass; 1024×560 and 768×600 large-text passes; and `light-long-names-{table,structure,sql}.png` with a widened sidebar. `light-narrow-expanded.png` and `light-narrow-expanded-scrolled.png` (and Dark equivalents) show the results overlay at both starting positions. Screenshots are local ephemeral artifacts. The 18 px narrow captures show the current database next to SQL editor, and the toolbar buttons have separate hit areas.

For a repeat capture in this workspace, the temporary fixture is kept in the ignored `.task/design-audit/audit-capture.spec.ts`; it is intentionally not part of the permanent regression suite. Copy it temporarily to `frontend/tests/browser/audit-capture.spec.ts`, run `cd frontend && npx playwright test tests/browser/audit-capture.spec.ts --output=/tmp/hyperpg-design-audit/capture-test-results`, then remove that temporary copy. The helper uses mocked database and update bindings, sets theme/font in local storage, disables screenshot animations, and writes to the Round 2 directory above. If the ignored helper is unavailable, the fixtures in `table-features.spec.ts` and `sql.spec.ts` can be used to reproduce the same sequence: select a table, capture Data and Structure, run a mocked SQL result, capture the editor and expanded view at initial and scrolled positions, then capture Settings and the connection form at the listed viewports. No real database is required.

Final stable verification by the parent: `npm run build` passed, `npm test` passed **12/12**, and the full browser suite passed **68/68** in 3.5 minutes. The browser run used the repository tests with an isolated temporary Playwright configuration at port 9256 and output under `/tmp/hyperpg-design-audit/root-export-tests-isolated`; its complete log is `/tmp/hyperpg-design-audit/root-final-browser.log`. The usual repository command is `cd frontend && npx playwright test --reporter=line`. `git diff --check` passed. The parent confirmed the same production source fingerprint before and after this run: **`1bb2668a275ac7db4b6129137cb443456fd98e3ffb966388ea96f25453d4d31d`**, covering all 32 files recursively under `frontend/src` and `frontend/public`, including untracked files (sorted relative paths; SHA-256 of each path + NUL + contents + NUL).

A parent review found one additional shared-control regression: a nested export's Save file click closed its surrounding Table actions disclosure before busy/error feedback could be seen. ActionGroup now dismisses only its direct command buttons; the nested export owns its asynchronous state and dismissal. A permanent browser regression exercises a held write, visible busy state, a rendered failure and a successful retry. This fix is included in the 68-test run. A first scoped check lost its reused server between tests; the isolated five-test rerun passed, followed by the full stable run above.

The initial fresh independent Round 2 audit and implementation-report handoff were interrupted by a provider usage limit. The code and verification above are preserved; a new Terra Max independent review was started after the stated reset time. No final independent Round 2 scores are claimed here until that review completes.

No real database or user data was accessed. Viewports below 560 px tall, assistive technologies, and native desktop rendering remain outside this pass.


### Independent Round 2 review

The fresh Terra Max review is in [design-audit-independent-round-2.md](design-audit-independent-round-2.md). It assigned **9** to colors and typography and **8.5** to the other five categories. It independently passed 18 existing scenarios and three of four additional scenarios. The remaining positive drawer hit-test failed: expanded SQL results covered Settings in the open mobile navigation drawer at 390×600 with 18 px text. An actual pointer click reproduced the interception. The reviewed production fingerprint was unchanged throughout the audit. These scores are also recorded in `design-scores.json`; the full goal was not achieved by Round 2.

## Round 3 — mobile navigation and expanded results

Opening mobile navigation now makes the SQL editor inactive through the same state gate used by application dialogs. Its existing layout effect collapses the expanded results portal and skips background focus restoration while inactive. The drawer therefore receives pointer interaction, and closing Settings restores focus to the navigation trigger. The normal editor, draft and result data remain available after navigation closes. This changes one activity condition in `App.tsx`; theme, type and layout styling are unchanged.

Two permanent browser regressions cover Light and Dark at 390×600 with 18 px text. They open Settings by an actual center-point pointer click from both normal and expanded results, verify dialog focus and return, and verify editor access after closing navigation via its scrim. Together with existing short/scrolled results, application-dialog and mobile Settings checks, **5/5** targeted browser tests passed. The production build passed again. The prior 68-test full suite and 12 functional checks cover Round 2; they are not claimed as a 70-test full run after this one-condition fix. The targeted run is recorded in `/tmp/hyperpg-design-audit/root-round-3-browser.log`.

Current production fingerprint: **`58d72bbf62bba3e062a4615876fea9a1aacb330cb98fed12f06316d1728b273b`**, using the same 32-file scope and algorithm as above. A new focused independent Terra Max re-audit is required to verify the reported blocker is resolved and reassess the affected categories. Final scores remain pending.


### Independent Round 3 review

[The round-three report](design-audit-independent-round-3.md) verified the pointer interception was fixed in Light and Dark. It retained colors and typography at **9**, raised spacing to **9**, and scored navigation, shared states, accessibility and responsive behavior **8.5** because forward Tab could focus and activate obscured workspace controls behind the open drawer. Its six focused scenarios passed, and a separate deliberate reproduction established that keyboard defect. Those results are not a clean product pass.

## Round 4 — mobile drawer keyboard behavior

The open mobile drawer now has a named dialog surface, a visible close button, initial focus, forward/reverse Tab containment, Escape handling and focus return. Covered workspace siblings become inert while navigation is open, and workspace shortcuts are suspended. Application dialogs opened from navigation retain their own focus management; closing them returns to the drawer. Closing navigation restores the prior inert states. Crossing to the desktop breakpoint closes the mobile drawer and restores workspace interaction.

New Light and Dark browser scenarios exercise 24 forward/reverse Tab steps from both normal and expanded SQL entry, visible focus, a nested connection dialog, Escape and return, the close button and mobile-to-desktop resizing. Both keyboard scenarios and three existing companion checks passed on the initial targeted run. Two pointer companion checks initially failed only because the newly added close button made an existing substring locator ambiguous; the scrim locator now uses its exact accessible name. The full stable browser suite passed **72/72** in 3.5 minutes after correcting that locator; log: `/tmp/hyperpg-design-audit/root-round-4-full-browser.log`. The production fingerprint remained unchanged across the run, and `git diff --check` passed. The production build passed. A fresh focused independent Terra Max audit will reassess the remaining categories against the unchanged rubric.

Round-four production fingerprint: **`1a5d73dc55077f952c467e200d022dd03e09e374075729f80901c1268826edbf`** across the same 32-file scope. Earlier round reports remain historical evidence; no final scores for this source are assigned until its independent review completes.


### Independent Round 4 review

[The round-four report](design-audit-independent-round-4.md) verified ordinary keyboard containment, but identified the 560/760 breakpoint mismatch, overlapping inert save/restore during drawer-originated dialog resizing, and large-text header crowding. Its independent scores were colors **9**, typography **9**, navigation/spacing/shared states **8.5**, and accessibility/responsive **8**. Ten permanent checks passed, while independent resize checks established the remaining defects. Round 4 therefore did not meet the goal despite the parent full suite passing 72/72.

## Round 5 — breakpoint, overlapping dialogs and header spacing

The drawer behavior and close-button visibility now use the actual 560 px overlay breakpoint. A shared `ui/inert.ts` helper keeps each background element inert until every overlay that needs it has released it, preserving its original state. Drawer and application-dialog cleanup can now run in either order during resizing. Dialog focus return also falls back to a visible navigation or Settings control when resizing hides its original opener.

The mobile drawer width scales with the user's text size up to 320 px, while preserving a visible scrim. The header keeps an explicit gap and can wrap on very small screens; at 18 px the title, close outline and Add connection target fit within the drawer without reducing shared button sizes. The close control is hidden above the overlay breakpoint.

Eight focused browser checks passed, including Light/Dark keyboard containment and hit areas, Settings pointer access, dialog handoff and the two new resize regressions. Each resize regression crosses 561, 600 and 1280 px both with and without a drawer-originated connection dialog, confirms background isolation during the dialog, verifies actual editor focus after closing, and covers returning to mobile before dismissing the dialog. The build and `git diff --check` pass. The full stable browser suite passed **74/74** in 4.9 minutes. The 33-file production fingerprint remained unchanged across the run. A fresh independent review is required before assigning final scores.

Production fingerprint: **`5a8275901bb941d43e27a613c758c43bd48dd82f7d3b501585cf77137d46532c`** across **33** files under `frontend/src` and `frontend/public`, including the new inert helper, using the same sorted path/content algorithm. Targeted log: `/tmp/hyperpg-design-audit/root-round-5-browser.log`; full log: `/tmp/hyperpg-design-audit/root-round-5-full-browser.log`.


### Independent Round 5 review — target achieved

[The final independent report](design-audit-independent-round-5.md) assigns **9/10 to all seven categories**. It verified the 560/561 breakpoint, both overlay-release orders, nested connection/Edit/Unsaved/Settings resize paths, actual editor focus and typing after dismissal, mobile keyboard containment and pointer access, default/18 px header geometry, and the 320 px companion. No material blocker remained in the inspected scope. Start/end fingerprints matched the parent's final stable source. The parent rechecked the same current fingerprint and full 74-test log before recording completion.

The earlier round scores and findings remain historical. The neutral Light/Dark themes and SQL syntax, Cream/Discord support, unbranded sidebar, differentiated tree typography, 40 px Settings close target and component-owned shared buttons are preserved. All requested design-audit work is complete within the rubric and inspected scope; no production edits followed the final review.
