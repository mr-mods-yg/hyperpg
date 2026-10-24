from pathlib import Path
import subprocess
import tempfile
import unittest

from nightly_notes import git, new_changelog_entries, previous_tag, release_notes


class NightlyNotesTests(unittest.TestCase):
    def test_previous_nightly_uses_numeric_sequence_and_same_version(self):
        tags = ["v1.0.8-nightly.9", "v1.0.8-nightly.10", "v1.0.8-nightly.12",
                "v1.0.9-nightly.1", "v1.0.7-nightly.99", "v1.0.7"]
        self.assertEqual(previous_tag(tags, "1.0.8-nightly.11"), "v1.0.8-nightly.10")

    def test_first_nightly_falls_back_to_latest_earlier_stable(self):
        self.assertEqual(previous_tag(["v1.0.6", "v1.0.7", "v1.0.8"], "1.0.8-nightly.1"), "v1.0.7")
        self.assertIsNone(previous_tag([], "1.0.8-nightly.1"))
        with self.assertRaises(ValueError):
            previous_tag([], "1.0.8")

    def test_new_entries_exclude_released_and_reformatted_notes(self):
        previous = "## [1.0.7]\n### Added\n- Existing feature\n- A wrapped\n  entry\n"
        current = "## [Unreleased]\n### Added\n- Existing feature\n- A wrapped entry\n### Fixed\n- A new fix\n## [1.0.7]\n- Older fix\n"
        self.assertEqual(new_changelog_entries(current, previous), [("Fixed", "- A new fix")])

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        git(self.root, "init", "--quiet")
        git(self.root, "config", "user.name", "Release tests")
        git(self.root, "config", "user.email", "release-tests@example.com")
        self.changelog = self.root / "CHANGELOG.md"
        self.changelog.write_text("## [Unreleased]\n\n### Added\n\n- Existing feature\n", encoding="utf-8")
        self.commit("feat: existing feature")
        git(self.root, "tag", "v1.0.7")

    def commit(self, subject):
        git(self.root, "add", ".")
        git(self.root, "commit", "--quiet", "--allow-empty", "-m", subject)
        return git(self.root, "rev-parse", "HEAD")

    def notes(self, version="1.0.8-nightly.1", source="HEAD"):
        return release_notes(self.root, version, source, "example/hyperpg", "https://example.com/run/123")

    def test_notes_include_new_curated_entries_commits_comparison_and_metadata(self):
        self.changelog.write_text(self.changelog.read_text() + "\n### Fixed\n\n- Publish real nightly notes\n", encoding="utf-8")
        sha = self.commit("fix: publish nightly changelogs")
        notes = self.notes()
        self.assertIn("### Fixed\n\n- Publish real nightly notes", notes)
        self.assertIn(f"fix: publish nightly changelogs ([{sha[:7]}]", notes)
        self.assertIn(f"/compare/v1.0.7...{sha}", notes)
        self.assertIn("<summary>Build details</summary>", notes)
        self.assertIn("https://example.com/run/123", notes)
        self.assertNotIn("Existing feature", notes)

    def test_nightly_rebuild_does_not_repeat_changes(self):
        self.commit("fix: previous nightly")
        git(self.root, "tag", "v1.0.8-nightly.1")
        notes = self.notes("1.0.8-nightly.2")
        self.assertIn("No source changes since [v1.0.8-nightly.1]", notes)
        self.assertNotIn("### Commits", notes)

    def test_stable_changelog_reorganization_does_not_repeat_existing_features(self):
        base = git(self.root, "rev-parse", "HEAD")
        git(self.root, "checkout", "--quiet", "-b", "stable")
        self.changelog.write_text("## [Unreleased]\n\n## [1.0.7]\n\n### Added\n- Reworded existing feature\n", encoding="utf-8")
        self.commit("chore: prepare stable changelog")
        git(self.root, "tag", "--force", "v1.0.7")
        git(self.root, "checkout", "--quiet", "-b", "nightly", base)
        self.commit("feat: new nightly feature")
        notes = self.notes()
        self.assertIn("feat: new nightly feature", notes)
        self.assertNotIn("Existing feature", notes)
        self.assertNotIn("### Added", notes)

    def test_commits_cover_changes_without_changelog_edits(self):
        self.commit("style: improve scrollbars")
        git(self.root, "tag", "v1.0.8-nightly.1")
        self.commit("feat: show column defaults")
        self.changelog.write_text("## [Unreleased]\n- Uncommitted work must stay private\n", encoding="utf-8")
        notes = self.notes("1.0.8-nightly.2")
        self.assertIn("feat: show column defaults", notes)
        self.assertNotIn("improve scrollbars", notes)
        self.assertNotIn("Uncommitted work", notes)

    def test_missing_changelog_still_produces_commit_notes(self):
        self.changelog.unlink()
        self.commit("chore: remove changelog")
        self.assertIn("chore: remove changelog", self.notes())

    def test_first_release_without_tags_includes_history(self):
        git(self.root, "tag", "--delete", "v1.0.7")
        self.assertIn("feat: existing feature", self.notes())

    def test_invalid_source_fails_instead_of_producing_incorrect_notes(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.notes(source="missing-commit")


if __name__ == "__main__":
    unittest.main()
