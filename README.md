# Git Time Machine

Step through a file's Git history right from the editor toolbar, without leaving the file you're working on.

## Features

Three buttons appear in the editor title bar (top-right) for any file tracked in a Git repository:

- **Previous** (`←`) — open a diff of the current file against an ever-older revision. Each click steps one revision further back in time.
- **Current** (`●`) — jump straight back to the live working file. Disabled until you've gone back.
- **Next** (`→`) — step one revision forward through history. Disabled until you've gone back.

The diff shows the historical revision on the left (`filename (sha)`) and your current working file on the right.

When the working tree is clean, the first **Previous** click lands on the genuinely previous version (the most recent commit's content is identical to the file on disk, so it's skipped). When you have uncommitted changes, the first **Previous** click compares them against `HEAD`.

## Requirements

- `git` must be available on your `PATH`.
- The file must live inside a Git repository.

## How it works

The extension resolves historical file contents with `git show <sha>:<path>` through a read-only virtual document provider, and renders comparisons using VS Code's built-in diff editor. File history is collected with `git log --follow`, so renames are tracked in the history list.

## Known limitations

- Loading a revision from *before* a rename may fail, because the revision is read using the file's current path.
- History is read once per file and refreshed when the file is saved.

## Development

```bash
npm install
npm run watch   # build in watch mode, then press F5 to launch the Extension Dev Host
npm run package # production build
npm run package:vsix  # produce an installable .vsix
```
