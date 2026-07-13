import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getBlame,
  getFileAtRevision,
  getFileHistory,
  getRepoRoot,
  hasUncommittedChanges,
  toRelativePath,
} from '../git';

/** Runs a git command synchronously in `cwd`, returning trimmed stdout. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Creates an isolated temp Git repository with a deterministic identity. */
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squeak-peek-test-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

/** Writes a file (creating parent dirs) and commits it with the given message. */
function commitFile(root: string, relPath: string, content: string, message: string): void {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  git(root, 'add', relPath);
  git(root, 'commit', '-q', '-m', message);
}

suite('git module', () => {
  const repos: string[] = [];

  function newRepo(): string {
    const root = makeRepo();
    repos.push(root);
    return root;
  }

  suiteTeardown(() => {
    for (const root of repos) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  suite('toRelativePath', () => {
    test('returns a forward-slash path relative to the repo root', () => {
      const root = path.join('/tmp', 'repo');
      const file = path.join(root, 'src', 'a', 'b.ts');
      assert.strictEqual(toRelativePath(root, file), 'src/a/b.ts');
    });

    test('returns just the basename for a top-level file', () => {
      const root = path.join('/tmp', 'repo');
      assert.strictEqual(toRelativePath(root, path.join(root, 'README.md')), 'README.md');
    });
  });

  suite('getRepoRoot', () => {
    test('resolves the repository root for a tracked file', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'hello\n', 'init');
      const resolved = await getRepoRoot(path.join(root, 'file.txt'));
      assert.ok(resolved, 'expected a repo root');
      assert.strictEqual(fs.realpathSync(resolved!), fs.realpathSync(root));
    });

    test('resolves the root from a nested subdirectory', async () => {
      const root = newRepo();
      commitFile(root, path.join('deep', 'nested', 'file.txt'), 'x\n', 'init');
      const resolved = await getRepoRoot(path.join(root, 'deep', 'nested', 'file.txt'));
      assert.ok(resolved);
      assert.strictEqual(fs.realpathSync(resolved!), fs.realpathSync(root));
    });

    test('returns undefined when the file is not in a Git repository', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squeak-peek-nogit-'));
      repos.push(dir);
      const resolved = await getRepoRoot(path.join(dir, 'whatever.txt'));
      assert.strictEqual(resolved, undefined);
    });
  });

  suite('getFileHistory', () => {
    test('returns commits newest-first with parsed metadata', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'v1\n', 'first commit');
      commitFile(root, 'file.txt', 'v2\n', 'second commit');
      commitFile(root, 'file.txt', 'v3\n', 'third commit');

      const history = await getFileHistory(root, 'file.txt');

      assert.strictEqual(history.length, 3);
      assert.strictEqual(history[0].subject, 'third commit');
      assert.strictEqual(history[1].subject, 'second commit');
      assert.strictEqual(history[2].subject, 'first commit');
      assert.strictEqual(history[0].author, 'Test User');
      assert.match(history[0].sha, /^[0-9a-f]{40}$/);
      assert.match(history[0].date, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('follows renames', async () => {
      const root = newRepo();
      commitFile(root, 'old-name.txt', 'content\n', 'create');
      git(root, 'mv', 'old-name.txt', 'new-name.txt');
      git(root, 'commit', '-q', '-m', 'rename');

      const history = await getFileHistory(root, 'new-name.txt');

      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0].subject, 'rename');
      assert.strictEqual(history[1].subject, 'create');
    });

    test('preserves subjects that contain tabs and newlines', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'x\n', 'normal');
      // A multi-line subject: git treats the first line as the subject.
      const abs = path.join(root, 'file.txt');
      fs.writeFileSync(abs, 'y\n');
      git(root, 'add', 'file.txt');
      git(root, 'commit', '-q', '-m', 'has\ttab in subject');

      const history = await getFileHistory(root, 'file.txt');
      assert.strictEqual(history[0].subject, 'has\ttab in subject');
    });

    test('returns an empty array for an untracked path', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'x\n', 'init');
      const history = await getFileHistory(root, 'does-not-exist.txt');
      assert.deepStrictEqual(history, []);
    });
  });

  suite('getFileAtRevision', () => {
    test('returns the file contents at a specific commit', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'first\n', 'c1');
      commitFile(root, 'file.txt', 'second\n', 'c2');

      const history = await getFileHistory(root, 'file.txt');
      const oldest = history[history.length - 1];

      const contents = await getFileAtRevision(root, oldest.sha, 'file.txt');
      assert.strictEqual(contents, 'first\n');
    });

    test('rejects when the path does not exist at that revision', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'only\n', 'init');
      const history = await getFileHistory(root, 'file.txt');

      await assert.rejects(() => getFileAtRevision(root, history[0].sha, 'missing.txt'));
    });
  });

  suite('hasUncommittedChanges', () => {
    test('is false when the working file matches HEAD', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'clean\n', 'init');
      assert.strictEqual(await hasUncommittedChanges(root, 'file.txt'), false);
    });

    test('is true with an unstaged modification', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'clean\n', 'init');
      fs.writeFileSync(path.join(root, 'file.txt'), 'dirty\n');
      assert.strictEqual(await hasUncommittedChanges(root, 'file.txt'), true);
    });

    test('is true with a staged-but-not-committed modification', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'clean\n', 'init');
      fs.writeFileSync(path.join(root, 'file.txt'), 'staged\n');
      git(root, 'add', 'file.txt');
      assert.strictEqual(await hasUncommittedChanges(root, 'file.txt'), true);
    });
  });

  suite('getBlame', () => {
    test('attributes each line to its commit with author metadata', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'line one\nline two\n', 'init');

      const blame = await getBlame(root, 'file.txt');

      assert.strictEqual(blame.length, 2);
      assert.strictEqual(blame[0].author, 'Test User');
      assert.strictEqual(blame[0].summary, 'init');
      assert.match(blame[0].sha, /^[0-9a-f]{40}$/);
      assert.ok(blame[0].authorTime > 0);
      assert.strictEqual(blame[0].uncommitted, false);
    });

    test('flags uncommitted lines against the working tree', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'committed\n', 'init');
      fs.appendFileSync(path.join(root, 'file.txt'), 'new uncommitted line\n');

      const blame = await getBlame(root, 'file.txt');

      assert.strictEqual(blame.length, 2);
      assert.strictEqual(blame[0].uncommitted, false);
      assert.strictEqual(blame[1].uncommitted, true);
    });

    test('blames the file as of a given revision', async () => {
      const root = newRepo();
      commitFile(root, 'file.txt', 'original\n', 'c1');
      commitFile(root, 'file.txt', 'original\nadded later\n', 'c2');

      const history = await getFileHistory(root, 'file.txt');
      const first = history[history.length - 1];

      const blame = await getBlame(root, 'file.txt', first.sha);

      assert.strictEqual(blame.length, 1);
      assert.strictEqual(blame[0].summary, 'c1');
    });
  });
});
