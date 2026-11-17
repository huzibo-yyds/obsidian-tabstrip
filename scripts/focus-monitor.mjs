/**
 * Focus monitor for e2e runs (report only, it never fails a run).
 *
 * Every ~200 ms it asks LaunchServices which app is frontmost (`lsappinfo front`, then
 * `lsappinfo info -only name -only bundlepath -only pid -only applicationtype <ASN>`) and records
 * every stretch of time in which that app is the sandbox Obsidian. It also looks up the sandbox's
 * own LaunchServices entry (`lsappinfo find bundlepath=<patched bundle>`) and records its
 * application type: "Foreground" means a Dock icon, "UIElement" and "BackgroundOnly" mean none.
 *
 * lsappinfo only talks to the LaunchServices daemon. No osascript, no System Events and no
 * Accessibility API are used, so nothing here can trigger a macOS permission prompt.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

const LSAPPINFO = '/usr/bin/lsappinfo';

function run(file, args) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { encoding: 'utf8', timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
	});
}

/** ASNs in lsappinfo output, normalised to the `ASN:0x0-0x1234:` form that `lsappinfo info` takes. */
export function parseAsns(text) {
	return [...text.matchAll(/ASN:(0x[0-9a-f]+-0x[0-9a-f]+)/gi)].map((m) => `ASN:${m[1]}:`);
}

/** Parses `lsappinfo info -only ...` output ("Key"="value" or "Key"=number lines). */
export function parseInfo(text) {
	const raw = {};
	for (const m of text.matchAll(/^"([^"]+)"=(.*)$/gm)) {
		let value = m[2].trim();
		if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
		raw[m[1]] = value;
	}
	// lsappinfo prints [ NULL ] for a missing value (e.g. while an app is quitting).
	const get = (key) => (raw[key] === undefined || raw[key] === '[ NULL ]' ? null : raw[key]);
	const pidText = get('pid');
	const pid = pidText !== null && /^\d+$/.test(pidText) ? Number(pidText) : null;
	return { name: get('LSDisplayName'), bundlePath: get('LSBundlePath'), pid, type: get('ApplicationType') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts polling. Options:
 *  - sandboxRoot: folder that holds the patched sandbox installers; an app whose bundle path is
 *    inside it is the sandbox;
 *  - sandboxBundles: bundle paths of the patched installers used in this run (for the app type);
 *  - rootPid: an app whose process descends from this pid (the e2e runner: wdio, ChromeDriver,
 *    then the sandbox) is the sandbox too, whatever LaunchServices says about its bundle;
 *  - intervalMs: poll interval (default 200).
 * Returns { stop(): Promise<summary> }.
 */
export function startFocusMonitor({ sandboxRoot, sandboxBundles = [], rootPid = process.pid, intervalMs = 200 }) {
	const root = path.resolve(sandboxRoot) + path.sep;
	const bundles = [...new Set(sandboxBundles.map((b) => path.resolve(b)))];
	const state = {
		intervalMs,
		polls: 0,
		frontSandboxPolls: 0,
		noFrontPolls: 0,
		errors: 0,
		lastError: null,
		episodes: [],
		sandboxApps: {},
	};
	const infoByAsn = new Map();
	let open = null;
	let stopped = false;

	/** True when `pid` is a descendant of rootPid (walks the parent chain with ps). */
	const descendsFromRoot = async (pid) => {
		let current = pid;
		for (let depth = 0; depth < 12 && current > 1; depth++) {
			let parent;
			try {
				parent = Number((await run('/bin/ps', ['-o', 'ppid=', '-p', String(current)])).trim());
			} catch {
				return false;
			}
			if (parent === rootPid) return true;
			if (!Number.isInteger(parent) || parent <= 1) return false;
			current = parent;
		}
		return false;
	};

	const inSandboxRoot = (bundlePath) => bundlePath !== null && path.resolve(bundlePath).startsWith(root);

	const describe = async (asn) => {
		const cached = infoByAsn.get(asn);
		if (cached) return cached;
		const info = parseInfo(await run(LSAPPINFO, ['info', '-only', 'name', '-only', 'bundlepath', '-only', 'pid', '-only', 'applicationtype', asn]));
		const sandbox = inSandboxRoot(info.bundlePath) || (info.pid !== null && (await descendsFromRoot(info.pid)));
		const entry = { ...info, sandbox };
		infoByAsn.set(asn, entry);
		return entry;
	};

	const scanSandboxApps = async () => {
		for (const bundle of bundles) {
			const asns = parseAsns(await run(LSAPPINFO, ['find', `bundlepath=${bundle}`]));
			for (const asn of asns) {
				// Read the type each time: an app can change it while it runs (e.g. app.dock.show()).
				const info = parseInfo(await run(LSAPPINFO, ['info', '-only', 'name', '-only', 'bundlepath', '-only', 'pid', '-only', 'applicationtype', asn]));
				let app = state.sandboxApps[asn];
				if (!app) {
					// Both identification rules, as evidence that the front-app check would catch it.
					const pidTree = info.pid !== null && (await descendsFromRoot(info.pid));
					app = state.sandboxApps[asn] = { pid: info.pid, name: info.name, bundlePath: info.bundlePath, inSandboxRoot: inSandboxRoot(info.bundlePath), pidTree, types: [], firstSeen: new Date().toISOString() };
				}
				if (info.type && !app.types.includes(info.type)) app.types.push(info.type);
			}
		}
	};

	const close = (at) => {
		if (!open) return;
		const ms = at - open.start;
		state.episodes.push({ start: new Date(open.start).toISOString(), ms, polls: open.polls, pid: open.pid });
		open = null;
	};

	const loop = (async () => {
		while (!stopped) {
			const t0 = Date.now();
			try {
				const asn = parseAsns(await run(LSAPPINFO, ['front']))[0];
				state.polls++;
				const front = asn ? await describe(asn) : null;
				if (!front) state.noFrontPolls++;
				if (front?.sandbox) {
					state.frontSandboxPolls++;
					if (open) open.polls++;
					else open = { start: t0, polls: 1, pid: front.pid };
				} else {
					close(t0);
				}
				await scanSandboxApps();
			} catch (e) {
				state.errors++;
				state.lastError = String(e && e.message ? e.message : e).slice(0, 300);
			}
			await sleep(Math.max(0, intervalMs - (Date.now() - t0)));
		}
	})();

	return {
		async stop() {
			stopped = true;
			await loop;
			close(Date.now());
			const totalMs = state.episodes.reduce((sum, e) => sum + e.ms, 0);
			const types = [...new Set(Object.values(state.sandboxApps).flatMap((a) => a.types))];
			return { ...state, times: state.episodes.length, totalMs, sandboxAppTypes: types };
		},
	};
}

/** One-line summaries for the run log. */
export function focusSummaryLines(focus) {
	const apps = Object.values(focus.sandboxApps);
	const both = apps.filter((a) => a.inSandboxRoot && a.pidTree).length;
	const typeText = apps.length
		? `${focus.sandboxAppTypes.join(', ') || 'unknown'} (${apps.length} sandbox launch${apps.length === 1 ? '' : 'es'} seen, ${both} matched by both bundle path and pid tree; "Foreground" = Dock icon)`
		: 'no sandbox app seen in LaunchServices';
	return [
		`[e2e] focus taken by sandbox: ${focus.times} times, total ~${focus.totalMs} ms (${focus.polls} polls every ${focus.intervalMs} ms, ${focus.frontSandboxPolls} with the sandbox frontmost${focus.errors ? `, ${focus.errors} poll error(s): ${focus.lastError}` : ''})`,
		`[e2e] sandbox app type (lsappinfo): ${typeText}`,
	];
}
