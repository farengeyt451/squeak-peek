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
		const out = await run(
			['log', '--follow', `--format=${format}`, '--date=short', '--', relPath],
			repoRoot,
		);
		return out
			.split(record)
			.map(entry => entry.replace(/^\s+/, ''))
			.filter(entry => entry.length > 0)
			.map(entry => {
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
