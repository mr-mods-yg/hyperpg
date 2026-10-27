"""Create nightly release notes from the exact source commit and prior tag."""

import argparse
from collections import OrderedDict
from pathlib import Path
import re
import subprocess
from urllib.parse import quote


NUMBER = r"(0|[1-9][0-9]*)"
STABLE = re.compile(rf"^v{NUMBER}\.{NUMBER}\.{NUMBER}$")
NIGHTLY = re.compile(rf"^v{NUMBER}\.{NUMBER}\.{NUMBER}-nightly\.{NUMBER}$")


def previous_tag(tags, version):
    target = NIGHTLY.fullmatch(f"v{version}")
    if target is None:
        raise ValueError(f"Invalid nightly version: {version}")
    base = tuple(map(int, target.groups()[:3]))
    sequence = int(target.group(4))
    nightlies, stable = [], []
    for tag in tags:
        match = NIGHTLY.fullmatch(tag)
        if match:
            numbers = tuple(map(int, match.groups()))
            if numbers[:3] == base and numbers[3] < sequence:
                nightlies.append((numbers[3], tag))
        match = STABLE.fullmatch(tag)
        if match:
            numbers = tuple(map(int, match.groups()))
            if numbers < base:
                stable.append((numbers, tag))
    return max(nightlies)[1] if nightlies else max(stable)[1] if stable else None


def changelog_entries(text, unreleased_only=False):
    active = not unreleased_only
    category = "Changed"
    entries = []
    for line in text.splitlines():
        if line.startswith("## "):
            active = not unreleased_only or bool(re.fullmatch(r"## \[Unreleased\]\s*", line, re.I))
            category = "Changed"
        elif active and line.startswith("### "):
            category = line[4:].strip()
        elif active and line.startswith("- "):
            entries.append((category, line))
        elif active and line.startswith(("  ", "\t")) and line.strip() and entries:
            old_category, item = entries[-1]
            entries[-1] = (old_category, f"{item}\n{line}")
    return entries


def new_changelog_entries(current, previous):
    known = {" ".join(item.split()) for _, item in changelog_entries(previous)}
    return [(category, item) for category, item in changelog_entries(current, True)
            if " ".join(item.split()) not in known]


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], check=True,
                          capture_output=True, text=True, encoding="utf-8").stdout.strip()


def changelog_at(root, ref):
    if ref is None:
        return ""
    try:
        return git(root, "show", f"{ref}:CHANGELOG.md")
    except subprocess.CalledProcessError:
        # Early releases may predate CHANGELOG.md; commit notes still apply.
        return ""


def release_notes(root, version, source, repository, run_url):
    baseline = previous_tag(git(root, "tag", "--list").splitlines(), version)
    sha = git(root, "rev-parse", "--verify", "--end-of-options", f"{source}^{{commit}}")
    history = git(root, "log", "--reverse", "--format=%H%x09%s",
                  f"{baseline}..{sha}" if baseline else sha)
    url = f"https://github.com/{repository}"
    lines = ["## Changes", ""]
    if history:
        categories = OrderedDict()
        # Stable releases can reword and move notes on a separate branch.
        # Compare curated entries to shared history so those edits are not new features.
        changelog_base = git(root, "merge-base", baseline, sha) if baseline else None
        for category, item in new_changelog_entries(changelog_at(root, sha), changelog_at(root, changelog_base)):
            categories.setdefault(category, []).append(item)
        for category, items in categories.items():
            lines.extend([f"### {category}", "", *items, ""])
        lines.extend(["### Commits", ""])
        for commit in history.splitlines():
            commit_sha, subject = commit.split("\t", 1)
            lines.append(f"- {subject} ([{commit_sha[:7]}]({url}/commit/{commit_sha}))")
        lines.append("")
    else:
        previous = f"[{baseline}]({url}/releases/tag/{quote(baseline, safe='')})"
        lines.extend([f"No source changes since {previous}. This is a rebuild of the same commit.", ""])
    if baseline:
        lines.extend([f"[Full changelog]({url}/compare/{quote(baseline, safe='')}...{sha})", ""])
    lines.extend(["<details>", "<summary>Build details</summary>", "",
                  f"Version: `{version}`", "", f"Commit: [`{sha[:7]}`]({url}/commit/{sha})", "",
                  f"[Workflow run]({run_url})", "", "</details>", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    notes = release_notes(Path.cwd(), args.version, args.source, args.repository, args.run_url)
    args.output.write_text(notes, encoding="utf-8")


if __name__ == "__main__":
    main()
