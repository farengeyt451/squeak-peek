import * as path from 'path';
import * as vscode from 'vscode';
import {
  BlameLine,
  CommitInfo,
  getBlame,
  getFileAtRevision,
  getFileHistory,
  getRepoRoot,
  hasUncommittedChanges,
  toRelativePath,
} from './git';

/** Custom URI scheme used for read-only historical file revisions. */
const SCHEME = 'squeak-peek';

const SHA_SHORTENED_LENGTH = 7;

/**
 * A time-travel session for a single working file.
 *
 * `position` is the index into the timeline:
 *   - 0            -> the current working file on disk (no diff)
 *   - k (k >= 1)   -> diff of `timeline[k - 1]` (left/older) vs the working file (right/newer)
 *
 * `timeline` holds the revisions worth comparing against the working file. When the
 * working tree is clean its content equals the newest commit, so that commit is
 * dropped to avoid an empty first diff; the first `prev` then lands on the genuinely
 * previous version.
 */
interface Session {
  fileFsPath: string;
  repoRoot: string;
  relPath: string;
  timeline: CommitInfo[];
  position: number;
  /** Newest commit that touched the file (real HEAD for this path), if any. */
  head: CommitInfo | undefined;
  /** True when the working file differs from HEAD (staged or unstaged). */
  dirty: boolean;
}

const sessions = new Map<string, Session>();
const repoRootCache = new Map<string, string | undefined>();

let lastFileFsPath: string | undefined;

/** Resolves the contents of a `squeak-peek:` URI by asking Git for that revision. */
class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { repoRoot, sha } = JSON.parse(decodeURIComponent(uri.query)) as {
      repoRoot: string;
      sha: string;
    };
    const relPath = uri.path.replace(/^\//, '');
    try {
      return await getFileAtRevision(repoRoot, sha, relPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return `// Squeak Peek: could not load "${relPath}" at ${sha.slice(0, 8)}.\n// ${message}`;
    }
  }
}

function revisionUri(repoRoot: string, sha: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    // Keep the real path so the basename and language mode are detected correctly.
    path: '/' + relPath,
    query: encodeURIComponent(JSON.stringify({ repoRoot, sha })),
  });
}

/**
 * Determines which working file the buttons should act on. Works for plain file
 * editors and for the diff editors this extension opens (whose modified side is the
 * working file). Falls back to the most recently active file editor.
 */
function activeFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;

  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri.fsPath;
  }

  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;

  if (input instanceof vscode.TabInputTextDiff) {
    if (input.modified.scheme === 'file') {
      return input.modified.fsPath;
    }
    if (input.original.scheme === 'file') {
      return input.original.fsPath;
    }
  }

  return lastFileFsPath;
}

async function resolveRepoRoot(fileFsPath: string): Promise<string | undefined> {
  const dir = path.dirname(fileFsPath);

  if (repoRootCache.has(dir)) {
    return repoRootCache.get(dir);
  }

  const root = await getRepoRoot(fileFsPath);

  repoRootCache.set(dir, root);

  return root;
}

/** Loads (and caches) the session for a file, preserving the position if already tracked. */
async function ensureSession(fileFsPath: string): Promise<Session | undefined> {
  const root = await resolveRepoRoot(fileFsPath);

  if (!root) {
    return undefined;
  }

  const existing = sessions.get(fileFsPath);

  if (existing) {
    return existing;
  }

  const relPath = toRelativePath(root, fileFsPath);
  const commits = await getFileHistory(root, relPath);

  // If the working tree matches HEAD, the newest commit is identical to the file on
  // disk, so drop it; otherwise the working file is itself a distinct "newest" state
  // and we keep every commit (the first `prev` shows the uncommitted changes).
  const head = commits[0];
  let timeline = commits;
  let dirty = false;
  if (commits.length > 0) {
    dirty = await hasUncommittedChanges(root, relPath);
    if (!dirty) {
      timeline = commits.slice(1);
    }
  }

  const session: Session = { fileFsPath, repoRoot: root, relPath, timeline, position: 0, head, dirty };

  sessions.set(fileFsPath, session);

  return session;
}

let statusBarItem: vscode.StatusBarItem | undefined;

function setContext(enabled: boolean, canPrev: boolean, canNext: boolean): void {
  void vscode.commands.executeCommand('setContext', 'squeakPeek:enabled', enabled);
  void vscode.commands.executeCommand('setContext', 'squeakPeek:canPrev', canPrev);
  void vscode.commands.executeCommand('setContext', 'squeakPeek:canNext', canNext);
}

/** How many commits back from HEAD the given position lands on. */
function commitsBehindHead(session: Session, position: number): number {
  if (position === 0) {
    return 0;
  }
  // With a dirty tree the whole history is kept, so timeline[0] is HEAD itself
  // (position 1 == 0 behind); with a clean tree HEAD was dropped, so position 1
  // is already one commit behind.
  return session.dirty ? position - 1 : position;
}

/** Short human summary of where the session currently sits, e.g. "3 behind HEAD (3/12)". */
function positionLabel(session: Session): string {
  if (session.position === 0) {
    return session.dirty ? 'Working tree (uncommitted)' : 'At HEAD';
  }
  const behind = commitsBehindHead(session, session.position);
  const where = behind === 0 ? 'At HEAD' : `${behind} behind HEAD`;
  return `${where} (${session.position}/${session.timeline.length})`;
}

/** Compact unicode timeline: ○ per revision, ◉ marks the current position (newest on the left). */
function timelineStrip(session: Session): string {
  const total = session.timeline.length;
  if (total === 0) {
    return '';
  }
  if (total > 25) {
    return `◉ ${session.position}/${total}`;
  }
  const dots: string[] = [];
  for (let p = 0; p <= total; p++) {
    dots.push(p === session.position ? '◉' : '○');
  }
  return dots.join('─');
}

function updateStatusBar(session: Session | undefined): void {
  if (!statusBarItem) {
    return;
  }
  if (!session) {
    statusBarItem.hide();
    return;
  }
  statusBarItem.text = `$(history) ${positionLabel(session)}`;
  const tip = new vscode.MarkdownString(undefined, true);
  tip.appendMarkdown('**Squeak Peek**\n\n');
  if (session.head) {
    tip.appendMarkdown(`HEAD → \`${session.head.sha}\`\n\n`);
  }
  if (session.position > 0) {
    const commit = session.timeline[session.position - 1];
    tip.appendMarkdown(`CURRENT → \`${commit.sha}\`\n\n`);
  }
  tip.appendMarkdown('Click to browse this file\u2019s history.');
  statusBarItem.tooltip = tip;
  statusBarItem.show();
}

async function updateContext(): Promise<void> {
  const fileFsPath = activeFilePath();
  const session = fileFsPath ? await ensureSession(fileFsPath) : undefined;

  if (!session) {
    setContext(false, false, false);
    updateStatusBar(undefined);
    return;
  }

  const canPrev = session.position < session.timeline.length;
  const canNext = session.position > 0;

  setContext(true, canPrev, canNext);
  updateStatusBar(session);
}

/** Opens the editor view that matches the session's current position. */
async function showView(session: Session): Promise<void> {
  const fileUri = vscode.Uri.file(session.fileFsPath);

  if (session.position === 0) {
    await vscode.window.showTextDocument(fileUri, { preview: false });
    return;
  }

  const commit = session.timeline[session.position - 1];
  const left = revisionUri(session.repoRoot, commit.sha, session.relPath);
  const base = path.basename(session.relPath);
  const title = `${base} (${commit.sha.slice(0, 8)}) \u2194 ${base}`;
  await vscode.commands.executeCommand('vscode.diff', left, fileUri, title, { preview: true });
}

/**
 * True while we are programmatically swapping the editor view. Opening a new
 * revision diff replaces (and thus "closes") the previous one, which we must
 * NOT mistake for the user closing the diff - otherwise the position would be
 * reset mid-navigation. Cleared on the next macrotask so any tab events emitted
 * by the open have already been handled.
 */
let navigating = false;

async function renderSession(session: Session): Promise<void> {
  navigating = true;
  try {
    await showView(session);
    await updateContext();
    updateAllVisibleBlame();
  } finally {
    setTimeout(() => {
      navigating = false;
    }, 0);
  }
}

async function withSession(action: (session: Session) => void): Promise<void> {
  const fileFsPath = activeFilePath();

  if (!fileFsPath) {
    return;
  }

  const session = await ensureSession(fileFsPath);

  if (!session) {
    void vscode.window.showInformationMessage('Squeak Peek: this file is not in a Git repository.');
    return;
  }

  action(session);

  await renderSession(session);
}

async function goPrevious(): Promise<void> {
  await withSession((session) => {
    if (session.timeline.length === 0) {
      void vscode.window.showInformationMessage('Squeak Peek: no previous revision for this file.');
      return;
    }
    if (session.position < session.timeline.length) {
      session.position++;
    }
  });
}

interface HistoryItem extends vscode.QuickPickItem {
  position: number;
  /** Full SHA for the copy action; undefined for the working-file row. */
  sha?: string;
}

const copyButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('copy'),
  tooltip: 'Copy full SHA',
};

function buildHistoryItems(session: Session): HistoryItem[] {
  const items: HistoryItem[] = [];
  const mark = (position: number) => (position === session.position ? '$(check) ' : '');

  items.push({
    label: `${mark(0)}$(file) Working file`,
    description: session.dirty ? 'uncommitted changes' : 'identical to HEAD',
    detail: session.head ? `HEAD → ${session.head.sha}` : undefined,
    position: 0,
  });

  session.timeline.forEach((commit, i) => {
    const position = i + 1;
    const behind = commitsBehindHead(session, position);
    const rel = behind === 0 ? 'HEAD' : `HEAD~${behind}`;
    const parent = session.timeline[i + 1];
    const parentPart = parent ? `parent ${parent.sha.slice(0, 8)}` : 'root commit';
    items.push({
      label: `${mark(position)}${commit.subject}`,
      description: `${commit.author} · ${commit.date}`,
      detail: `${commit.sha}  ·  ${rel}  ·  ${parentPart}`,
      position,
      sha: commit.sha,
      buttons: [copyButton],
    });
  });

  return items;
}

async function showHistory(): Promise<void> {
  const fileFsPath = activeFilePath();

  if (!fileFsPath) {
    return;
  }

  const session = await ensureSession(fileFsPath);

  if (!session) {
    void vscode.window.showInformationMessage('Squeak Peek: this file is not in a Git repository.');
    return;
  }

  if (session.timeline.length === 0) {
    void vscode.window.showInformationMessage('Squeak Peek: no history for this file yet.');
    return;
  }

  const qp = vscode.window.createQuickPick<HistoryItem>();
  const strip = timelineStrip(session);
  qp.title = `Squeak Peek - ${positionLabel(session)}${strip ? `   ${strip}` : ''}`;
  qp.placeholder = 'Select a revision to open it · use the copy icon to copy its full SHA';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;

  const items = buildHistoryItems(session);
  qp.items = items;
  qp.activeItems = items.filter((item) => item.position === session.position);

  qp.onDidTriggerItemButton(async (event) => {
    if (event.item.sha) {
      await vscode.env.clipboard.writeText(event.item.sha);
      void vscode.window.showInformationMessage(`Copied ${event.item.sha}`);
    }
  });

  qp.onDidAccept(async () => {
    const pick = qp.selectedItems[0];
    qp.hide();
    if (pick && pick.position !== session.position) {
      session.position = pick.position;
      await renderSession(session);
    }
  });

  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function goNext(): Promise<void> {
  await withSession((session) => {
    if (session.position > 0) {
      session.position--;
    }
  });
}

/**
 * Inline current-line blame, shown only inside the diff editors this extension
 * opens (the third-party/built-in blame providers suppress themselves in diffs).
 * The left pane is blamed as of its revision SHA; the right pane is blamed live
 * against the working tree.
 */
let blameDecoration: vscode.TextEditorDecorationType | undefined;

/** Cached blame results keyed per revision (left) or per working file (right). */
const blameCache = new Map<string, Promise<BlameLine[]>>();

/** The first N digits of SHA commit */
function truncatedSHA(sha: string): string {
  return sha.slice(0, SHA_SHORTENED_LENGTH);
}

/** Human-friendly "N units ago" from an epoch-seconds timestamp. */
function relativeTime(epochSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = seconds;
  let unit = 'second';
  for (const [size, name] of units) {
    if (value < size) {
      unit = name;
      break;
    }
    value = Math.floor(value / size);
    unit = name;
  }
  if (unit === 'second' && value < 10) {
    return 'just now';
  }
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/** Resolves the blame source for an editor, or undefined if blame should not show there. */
async function blameSourceForEditor(editor: vscode.TextEditor): Promise<Promise<BlameLine[]> | undefined> {
  const uri = editor.document.uri;

  if (uri.scheme === SCHEME) {
    const { repoRoot, sha } = JSON.parse(decodeURIComponent(uri.query)) as { repoRoot: string; sha: string };
    const relPath = uri.path.replace(/^\//, '');
    const key = `L|${repoRoot}|${sha}|${relPath}`;
    let blame = blameCache.get(key);
    if (!blame) {
      blame = getBlame(repoRoot, relPath, sha).catch(() => [] as BlameLine[]);
      blameCache.set(key, blame);
    }
    return blame;
  }

  if (uri.scheme === 'file') {
    // Only annotate a working file when it is the modified side of one of our diffs.
    const fsPath = uri.fsPath;
    const inDiff = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some(
        (tab) =>
          tab.input instanceof vscode.TabInputTextDiff &&
          tab.input.original.scheme === SCHEME &&
          tab.input.modified.scheme === 'file' &&
          tab.input.modified.fsPath === fsPath,
      ),
    );
    if (!inDiff) {
      return undefined;
    }

    const repoRoot = await resolveRepoRoot(fsPath);
    if (!repoRoot) {
      return undefined;
    }
    const relPath = toRelativePath(repoRoot, fsPath);
    const key = `R|${repoRoot}|${relPath}`;
    let blame = blameCache.get(key);
    if (!blame) {
      blame = getBlame(repoRoot, relPath).catch(() => [] as BlameLine[]);
      blameCache.set(key, blame);
    }
    return blame;
  }

  return undefined;
}

/** Draws (or clears) the current-line blame annotation for a single editor. */
async function updateBlameFor(editor: vscode.TextEditor | undefined): Promise<void> {
  if (!blameDecoration || !editor) {
    return;
  }

  const source = await blameSourceForEditor(editor);
  if (!source) {
    editor.setDecorations(blameDecoration, []);
    return;
  }

  const blame = await source;
  const line = editor.selection.active.line;
  const entry = blame[line];
  if (!entry) {
    editor.setDecorations(blameDecoration, []);
    return;
  }

  const label = entry.uncommitted
    ? 'You · Uncommitted changes'
    : `${entry.author} • ${relativeTime(entry.authorTime)} • ${truncatedSHA(entry.sha)}`;

  const eol = editor.document.lineAt(line).text.length;
  const range = new vscode.Range(line, eol, line, eol);
  editor.setDecorations(blameDecoration, [{ range, renderOptions: { after: { contentText: label } } }]);
}

function updateAllVisibleBlame(): void {
  for (const editor of vscode.window.visibleTextEditors) {
    void updateBlameFor(editor);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const initial = vscode.window.activeTextEditor;

  if (initial?.document.uri.scheme === 'file') {
    lastFileFsPath = initial.document.uri.fsPath;
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'squeakPeek.current';

  blameDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 3em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
  });

  context.subscriptions.push(
    statusBarItem,
    blameDecoration,
    vscode.window.onDidChangeTextEditorSelection((event) => {
      void updateBlameFor(event.textEditor);
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        void updateBlameFor(editor);
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider()),
    vscode.commands.registerCommand('squeakPeek.prev', goPrevious),
    vscode.commands.registerCommand('squeakPeek.current', showHistory),
    vscode.commands.registerCommand('squeakPeek.next', goNext),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri.scheme === 'file') {
        lastFileFsPath = editor.document.uri.fsPath;
      }
      void updateContext();
      void updateBlameFor(editor);
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      // Closing a revision diff ends that time-travel session: rewind to the
      // working file so the next `Previous` starts one commit back, not from
      // wherever the closed diff had wandered to. Skip while we're navigating,
      // since stepping to a new revision replaces (closes) the previous diff.
      if (!navigating) {
        for (const tab of event.closed) {
          const input = tab.input;
          if (
            input instanceof vscode.TabInputTextDiff &&
            input.original.scheme === SCHEME &&
            input.modified.scheme === 'file'
          ) {
            const session = sessions.get(input.modified.fsPath);
            if (session) {
              session.position = 0;
            }
          }
        }
      }
      void updateContext();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // History may have changed; drop the cached session so it reloads on next use.
      sessions.delete(doc.uri.fsPath);
      // Blame for the working file (and possibly its history) is now stale.
      blameCache.clear();
      void updateContext();
      updateAllVisibleBlame();
    }),
  );

  void updateContext();
}

export function deactivate(): void {
  sessions.clear();
  repoRootCache.clear();
  blameCache.clear();
}
