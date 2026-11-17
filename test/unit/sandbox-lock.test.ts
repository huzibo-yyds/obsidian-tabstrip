import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_NAME, acquireSandboxLock, lockOwner } from '../../scripts/sandbox-lock.mjs';

// One sandbox at a time across worktrees: the lock lives in the shared Obsidian cache.
const dirs: string[] = [];
const tmp = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tabstrip-lock-'));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('sandbox lock', () => {
	it('is taken by this process and refused to a second caller that does not wait', async () => {
		const cache = tmp();
		expect(await acquireSandboxLock({ cacheDir: cache, tool: 'test', wait: false })).toBe(true);
		expect(lockOwner(cache)?.pid).toBe(process.pid);
		const said: string[] = [];
		expect(await acquireSandboxLock({ cacheDir: cache, tool: 'second', wait: false, say: (m: string) => { said.push(m); } })).toBe(false);
		expect(said.join(' ')).toContain(`pid ${process.pid}`);
	});

	it('removes a lock whose owner process is gone', () => {
		const cache = tmp();
		const dir = path.join(cache, LOCK_NAME);
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 12345, tool: 'gone' }));
		expect(lockOwner(cache)).toBeNull();
		expect(fs.existsSync(dir)).toBe(false);
	});
});
