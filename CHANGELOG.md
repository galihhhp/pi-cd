# Changelog

## [0.1.0] - 2026-02-14

First release.

- `/cd <path>` moves the session working directory, carrying the conversation as a forked session.
- Interactive folder picker with live fuzzy search on every keystroke, drill-down navigation, and matches against subdirectories, recent destinations and bookmark names.
- `--root` jumps to the nearest project root, preferring `.git` over package manifests; `--home` and `~` reach the home directory.
- `-` returns to the previous directory; `--recents` picks from recently visited ones.
- `--save`, `--remove` and `@name` add named directory bookmarks.
- `--new` switches without carrying the conversation.
- Directory completions, case-insensitive, with flag completions after `-`.
- Typed paths are preserved for display, recents and bookmarks, while sessions are created against the resolved path so resume keeps working.
- Symlink-aware comparisons.
- Path handling is written against `node:path` separators; not yet exercised on Windows.
- Busy-guard confirms before aborting a streaming turn.
