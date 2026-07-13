import { execFile } from 'child_process';
import * as path from 'path';

export interface CommitInfo {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.toString().trim() || err.message));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

/** Returns the absolute repository root for a file, or undefined if it is not in a Git repo. */
export async function getRepoRoot(fileFsPath: string): Promise<string | undefined> {
  try {
    const out = await run(['rev-parse', '--show-toplevel'], path.dirname(fileFsPath));
    const root = out.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Git wants forward-slash paths relative to the repository root. */
export function toRelativePath(repoRoot: string, fileFsPath: string): string {
  return path.relative(repoRoot, fileFsPath).split(path.sep).join('/');
}

/** Commits that touched the file, newest first. Follows renames. */
export async function getFileHistory(repoRoot: string, relPath: string): Promise<CommitInfo[]> {
  // Use unit/record separators so subjects containing tabs/newlines don't break parsing.
  const unit = '\u001f';
  const record = '\u001e';
  const format = ['%H', '%an', '%ad', '%s'].join(unit) + record;

  try {
    const out = await run(['log', '--follow', `--format=${format}`, '--date=short', '--', relPath], repoRoot);
    return out
      .split(record)
      .map((entry) => entry.replace(/^\s+/, ''))
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const [sha, author, date, subject] = entry.split(unit);
        return { sha, author, date, subject };
      });
  } catch {
    return [];
  }
}

/** Raw file contents at a specific revision. Throws if the path does not exist at that revision. */
export async function getFileAtRevision(repoRoot: string, sha: string, relPath: string): Promise<string> {
  return run(['show', `${sha}:${relPath}`], repoRoot);
}

/** True if the working file differs from HEAD (staged or unstaged changes). */
export async function hasUncommittedChanges(repoRoot: string, relPath: string): Promise<boolean> {
  try {
    // `--quiet` exits with code 1 when there are differences, which rejects the promise.
    await run(['diff', '--quiet', 'HEAD', '--', relPath], repoRoot);
    return false;
  } catch {
    return true;
  }
}

/** Blame info for a single line of a file. */
export interface BlameLine {
  sha: string;
  author: string;
  /** Author time in epoch seconds. */
  authorTime: number;
  summary: string;
  /** True for lines not yet committed (blamed against the working tree). */
  uncommitted: boolean;
}

const ZERO_SHA = /^0{40}$/;

/**
 * Runs `git blame --porcelain` and returns per-line authorship, indexed by
 * zero-based line number. When `rev` is omitted the working tree is blamed
 * (uncommitted lines come back flagged); otherwise the file is blamed as of `rev`.
 */
export async function getBlame(repoRoot: string, relPath: string, rev?: string): Promise<BlameLine[]> {
  const args = ['blame', '--porcelain'];
  if (rev) {
    args.push(rev);
  }
  args.push('--', relPath);

  const out = await run(args, repoRoot);
  return parseBlame(out);
}

/**
 * Parses `git blame --porcelain` output. Commit metadata (author, time, summary)
 * is only emitted the first time a commit appears, so we cache it per SHA and
 * reuse it for later lines that reference the same commit.
 */
function parseBlame(out: string): BlameLine[] {
  const lines = out.split('\n');
  const meta = new Map<string, { author: string; authorTime: number; summary: string }>();
  const result: BlameLine[] = [];

  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    if (header.length === 0) {
      break;
    }

    const parts = header.split(' ');
    const sha = parts[0];
    const finalLine = parseInt(parts[2], 10);
    i++;

    const entry = meta.get(sha) ?? { author: '', authorTime: 0, summary: '' };
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const line = lines[i];
      i++;
      if (line.startsWith('author ')) {
        entry.author = line.slice('author '.length);
      } else if (line.startsWith('author-time ')) {
        entry.authorTime = parseInt(line.slice('author-time '.length), 10);
      } else if (line.startsWith('summary ')) {
        entry.summary = line.slice('summary '.length);
      }
    }
    meta.set(sha, entry);

    // The tab-prefixed content line follows the metadata; skip it.
    if (i < lines.length && lines[i].startsWith('\t')) {
      i++;
    }

    if (Number.isFinite(finalLine) && finalLine > 0) {
      result[finalLine - 1] = {
        sha,
        author: entry.author,
        authorTime: entry.authorTime,
        summary: entry.summary,
        uncommitted: ZERO_SHA.test(sha),
      };
    }
  }

  return result;
}
