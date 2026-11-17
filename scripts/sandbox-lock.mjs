/**
 * One sandbox at a time, across checkouts (git worktrees) and tools (scripts/e2e.mjs, scripts/try.mjs).
 *
 * All sandboxes share the patched installer cache and the sandbox's own macOS preferences domain
 * ("Obsidian"), so two at once would delete each other's keys and fight over ports. The lock is a
 * directory in the Obsidian cache (mkdir is atomic) holding the owner's pid. A run waits for the lock
 * and also while any sandbox process is still running (a run from an older checkout without the lock).
 * A lock whose owner process is gone is stale and removed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_NAME = 'tabstrip-sandbox.lock';

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e && e.code === 'EPERM';
	}
}

/** Sandbox app processes started from the cache (main processes and chromedriver). */
export function runningSandboxes(cacheDir) {
	const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
	return out
		.split('\n')
		.map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
		.filter((m) => m && m[2].startsWith(cacheDir) && !m[2].includes('--type='))
		.map((m) => ({ pid: Number(m[1]), command: m[2].slice(0, 200) }));
}

/**
 * Current owner of the lock, or null (removes a stale lock).
 * @param {string} cacheDir
 * @returns {{ pid: number, tool: string, cwd?: string, startedAt?: string } | null}
 */
export function lockOwner(cacheDir) {
	const dir = path.join(cacheDir, LOCK_NAME);
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
	} catch {
		if (!fs.existsSync(dir)) return null;
		// Just created by another run that has not written owner.json yet: treat as held for a moment.
		const age = Date.now() - fs.statSync(dir).mtimeMs;
		if (age < 10_000) return { pid: -1, tool: 'unknown (starting)' };
		fs.rmSync(dir, { recursive: true, force: true });
		return null;
	}
	if (!alive(owner.pid)) {
		fs.rmSync(dir, { recursive: true, force: true });
		return null;
	}
	return owner;
}

/**
 * Waits until no other sandbox runs, then takes the lock for this process (released on exit).
 * wait=false: return false at once instead of waiting. Returns true when the lock is held.
 * @param {{ cacheDir: string, tool: string, say?: (message: string) => void, wait?: boolean, timeoutMs?: number }} options
 * @returns {Promise<boolean>}
 */
export async function acquireSandboxLock({ cacheDir, tool, say = () => {}, wait = true, timeoutMs = 4 * 3600_000 }) {
	const dir = path.join(cacheDir, LOCK_NAME);
	fs.mkdirSync(cacheDir, { recursive: true });
	const started = Date.now();
	let lastSay = 0;
	for (;;) {
		const owner = lockOwner(cacheDir);
		const procs = owner ? [] : runningSandboxes(cacheDir);
		if (!owner && procs.length === 0) {
			try {
				fs.mkdirSync(dir);
				fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, tool, cwd: process.cwd(), startedAt: new Date().toISOString() }));
				process.on('exit', () => {
					try {
						const o = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
						if (o.pid === process.pid) fs.rmSync(dir, { recursive: true, force: true });
					} catch {
						/* already gone */
					}
				});
				return true;
			} catch (e) {
				if (!e || e.code !== 'EEXIST') throw e;
				continue; // lost the race; look again
			}
		}
		if (!wait) {
			say(`another sandbox is running (${owner ? `${owner.tool} pid ${owner.pid} in ${owner.cwd}` : procs.map((p) => `pid ${p.pid}`).join(', ')})`);
			return false;
		}
		if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the sandbox lock');
		if (Date.now() - lastSay > 60_000) {
			say(`waiting for the other sandbox to finish (${owner ? `${owner.tool} pid ${owner.pid} in ${owner.cwd}` : procs.map((p) => `pid ${p.pid}`).join(', ')})`);
			lastSay = Date.now();
		}
		await new Promise((r) => setTimeout(r, 10_000));
	}
}
