# Change Log

All notable changes to the **Git Time Machine** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-07-06

### Added

- **Status-bar position readout** — an ambient `⟳ N behind HEAD (k/total)` item shows
  where you are in a file's history at a glance; click it to open the history picker.
- Rich status-bar tooltip showing the HEAD and current revision SHAs.
- Compact unicode timeline strip (`○─◉─○ …`) in the history picker title.

### Changed

- Renamed the **History** command from _"Current (Working) File"_ to _"Show Position
  in History"_ and made it always available (`gtm:enabled`) rather than gated behind a
  separate `gtm:canCurrent` context.
- Clearer toolbar button descriptions and history picker labels (relative position,
  parent commit, copyable full SHA).

## [1.0.0] - 2026-06-25

### Added

- New extension icon and refreshed branding.
- Expanded feature documentation in the README.

### Changed

- Reordered the **◄ ⟳ ►** toolbar buttons via explicit navigation command groups so
  they appear in chronological order in the editor title bar.

## [0.0.1] - 2026-06-25

### Added

- Initial release of Git Time Machine.
- **Previous / History / Next** toolbar buttons to step backward and forward through a
  file's Git history and diff each revision against the working copy.
- Side-by-side diffs of a historical revision against the current file.
- Smart first step that skips the commit identical to a clean working tree and compares
  uncommitted changes against `HEAD` first.
- Rename-aware history via `git log --follow`.
- History quick-pick to jump to any revision and copy its full SHA.
- Zero configuration — works in any Git repository.

[1.0.1]: https://github.com/farengeyt451/git-time-machine/releases/tag/v1.0.1
[1.0.0]: https://github.com/farengeyt451/git-time-machine/releases/tag/v1.0.0
[0.0.1]: https://github.com/farengeyt451/git-time-machine/releases/tag/v0.0.1
