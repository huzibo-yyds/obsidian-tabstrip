import { describe, expect, it } from 'vitest';
import { runSyntheticSelfTest } from '../../scripts/host-guard-selftest.mjs';

// The guard is the safety net of every e2e run, so its negative cases run with the unit tests.
// This suite only touches a fake host built in a temp dir; it never reads or writes the real host.
describe('host-safety guard (synthetic host)', () => {
	it('reports every host change and ignores workspace.json', async () => {
		const results = await runSyntheticSelfTest();
		const missed = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);
		expect(missed).toEqual([]);
		expect(results.filter((r) => r.expectViolation).length).toBeGreaterThanOrEqual(10);
	}, 30_000);
});
