import { describe, expect, it } from 'vitest';
import { focusSummaryLines, parseAsns, parseInfo } from '../../scripts/focus-monitor.mjs';

// Parsing of `lsappinfo` output for the e2e focus monitor (no lsappinfo call here).
describe('focus monitor parsing', () => {
	it('reads ASNs from `lsappinfo front` and `lsappinfo find` output', () => {
		expect(parseAsns('ASN:0x0-0x42042:\n')).toEqual(['ASN:0x0-0x42042:']);
		expect(parseAsns('ASN:0x0-0x7d07d-"Obsidian": ASN:0x0-0x1b01b-"Obsidian":\n')).toEqual(['ASN:0x0-0x7d07d:', 'ASN:0x0-0x1b01b:']);
		expect(parseAsns('[ NULL ]\n')).toEqual([]);
		expect(parseAsns('')).toEqual([]);
	});

	it('reads name, bundle path, pid and application type from `lsappinfo info -only ...`', () => {
		const text = '"LSDisplayName"="Obsidian"\n"LSBundlePath"="/tmp/cache/tabstrip-sandbox-installer/darwin-arm64/Obsidian-1.5.8"\n"pid"=4242\n"ApplicationType"="BackgroundOnly"\n';
		expect(parseInfo(text)).toEqual({
			name: 'Obsidian',
			bundlePath: '/tmp/cache/tabstrip-sandbox-installer/darwin-arm64/Obsidian-1.5.8',
			pid: 4242,
			type: 'BackgroundOnly',
		});
		expect(parseInfo('')).toEqual({ name: null, bundlePath: null, pid: null, type: null });
		// lsappinfo prints [ NULL ] for values an app no longer has (e.g. while it quits).
		expect(parseInfo('"pid"=[ NULL ]\n"ApplicationType"=[ NULL ]\n').type).toBeNull();
	});

	it('prints the summary line the e2e log greps for', () => {
		const lines = focusSummaryLines({
			intervalMs: 200,
			polls: 40,
			frontSandboxPolls: 3,
			errors: 0,
			lastError: null,
			times: 1,
			totalMs: 612,
			sandboxApps: { 'ASN:0x0-0x1:': { types: ['Foreground'], inSandboxRoot: true, pidTree: true } },
			sandboxAppTypes: ['Foreground'],
		});
		expect(lines[0]).toMatch(/^\[e2e\] focus taken by sandbox: 1 times, total ~612 ms/);
		expect(lines[1]).toContain('Foreground');
		expect(lines[1]).toContain('1 matched by both bundle path and pid tree');
	});
});
