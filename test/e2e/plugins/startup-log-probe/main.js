// Test-only helper plugin (never shipped). It loads together with tabstrip when the sandbox
// starts and logs two known messages, so the e2e suite can prove that console output from
// plugin startup reaches the browser log it inspects.
//
// Step L6: it also watches the first frames after start-up (requestAnimationFrame runs right
// before each paint): in every frame it checks that no strip's shown tab and not the active tab
// has a hidden header (the collapsed-group class, visibility hidden, or no width). The record is
// read by the restart cases (window.__tabstripFrames). It only reads the page.
const { Plugin } = require('obsidian');

const WATCH_MS = 20000;

function watchFrames(app) {
	const record = { started: performance.now(), layoutReadyAtLoad: app.workspace.layoutReady === true, frames: 0, decoratedFrames: 0, firstDecorated: null, maxCollapsedHeaders: 0, violations: [], errors: 0 };
	window.__tabstripFrames = record;
	// Hidden: the collapsed-group class, visibility hidden, or no width while the other headers of
	// its strip have one (before Obsidian's first layout every header has width 0; that is not hiding).
	const hidden = (el) => {
		if (!el || !el.isConnected) return false;
		const cs = el.ownerDocument.defaultView.getComputedStyle(el);
		if (el.classList.contains('tabstrip-collapsed') || cs.visibility === 'hidden') return true;
		if (el.getBoundingClientRect().width > 0) return false;
		const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((h) => h !== el && h.classList.contains('workspace-tab-header')) : [];
		return siblings.some((h) => h.getBoundingClientRect().width > 0);
	};
	// Positive control for the tests: the same check, callable on any header.
	window.__tabstripFrameHidden = hidden;
	const frame = () => {
		try {
			record.frames++;
			const ws = app.workspace;
			const strips = new Set();
			ws.iterateAllLeaves((leaf) => {
				const root = leaf.getRoot();
				if ((root === ws.rootSplit || root === ws.floatingSplit) && leaf.parent && Array.isArray(leaf.parent.children)) strips.add(leaf.parent);
			});
			const shown = [];
			for (const tabs of strips) {
				const leaf = tabs.children[tabs.currentTab];
				if (leaf && !tabs.isStacked) shown.push(leaf);
			}
			const active = ws.activeLeaf;
			if (active && strips.has(active.parent) && !active.parent.isStacked) shown.push(active);
			const chips = document.querySelectorAll('.tabstrip-chip').length;
			const collapsed = document.querySelectorAll('.workspace-tab-header.tabstrip-collapsed').length;
			if (chips > 0) {
				record.decoratedFrames++;
				if (record.firstDecorated === null) {
					record.firstDecorated = { frame: record.frames, ms: performance.now() - record.started, chips, collapsedHeaders: collapsed };
				}
			}
			record.maxCollapsedHeaders = Math.max(record.maxCollapsedHeaders, collapsed);
			for (const leaf of shown) {
				if (hidden(leaf.tabHeaderEl) && record.violations.length < 50) {
					const el = leaf.tabHeaderEl;
					const reason = el.classList.contains('tabstrip-collapsed') ? 'class' : el.ownerDocument.defaultView.getComputedStyle(el).visibility === 'hidden' ? 'visibility' : 'width';
					record.violations.push({ frame: record.frames, leafId: leaf.id, reason, ms: performance.now() - record.started });
				}
			}
		} catch {
			record.errors++;
		}
		if (performance.now() - record.started < WATCH_MS) window.requestAnimationFrame(frame);
	};
	window.requestAnimationFrame(frame);
}

// Step L6: the bookkeeping of the main window's ResizeObserver observations that the e2e error
// watch uses (test/e2e/helpers.ts startErrorWatch, same structure), started here while Obsidian
// builds the layout, so observations Obsidian makes for the pop-outs it restores after a restart
// are known too. Test-only, like the rest of this plugin.
function trackResizeObservers() {
	if (window.e2eRoEarly) return;
	const live = new Set();
	const proto = window.ResizeObserver.prototype;
	const observe = Reflect.get(proto, 'observe');
	const unobserve = Reflect.get(proto, 'unobserve');
	const disconnect = Reflect.get(proto, 'disconnect');
	proto.observe = function (target, options) {
		live.add({ obs: new WeakRef(this), el: new WeakRef(target), plugin: (new Error().stack ?? '').includes('plugin:tabstrip') });
		observe.call(this, target, options);
	};
	proto.unobserve = function (target) {
		for (const t of live) if (t.obs.deref() === this && t.el.deref() === target) live.delete(t);
		unobserve.call(this, target);
	};
	proto.disconnect = function () {
		for (const t of live) if (t.obs.deref() === this) live.delete(t);
		disconnect.call(this);
	};
	window.e2eRoEarly = { live, unobserve: (obs, el) => unobserve.call(obs, el) };
}

// L6 review round 1: everything printed as an error or warning, and every uncaught error or
// rejection, from the moment this plugin loads (before Tabstrip restores its session in
// onLayoutReady). The restart cases read window.__e2eStartupConsole after every real restart.
// It only records; it passes every call on unchanged.
function watchConsole() {
	if (window.__e2eStartupConsole) return;
	const record = { errors: [], warnings: [], uncaught: [], controls: 0 };
	window.__e2eStartupConsole = record;
	const text = (args) => args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ').slice(0, 500);
	const error = console.error;
	const warn = console.warn;
	console.error = function (...args) {
		// The probe's own control call (below) is counted and not printed, so the browser log and
		// the other specs' probe checks see the same lines as before.
		if (args[0] === 'e2e-startup-hook control') {
			record.controls++;
			return undefined;
		}
		if (record.errors.length < 50) record.errors.push(text(args));
		return error.apply(this, args);
	};
	console.warn = function (...args) {
		if (record.warnings.length < 50) record.warnings.push(text(args));
		return warn.apply(this, args);
	};
	window.addEventListener('error', (e) => {
		if (record.uncaught.length < 50) record.uncaught.push(`error: ${e.message}`);
	});
	window.addEventListener('unhandledrejection', (e) => {
		if (record.uncaught.length < 50) record.uncaught.push(`rejection: ${text([e.reason])}`);
	});
}


// Step V1: the vertical tab strip in the first frames after start-up. In every frame it records
// whether the main window's .workspace has the strip (as a child) and the tabstrip-vertical class,
// and how many native tab header rows of the root split are on screen (height > 0). A frame where
// the class and the strip disagree, where the strip shows next to native rows, or where neither the
// strip nor any native row shows while the root split has tabs, is a bad frame. Read by the V1
// restart cases (window.__tabstripVFrames). Frames where the strip is there but still has no row
// while the root split has tabs are counted apart (emptyRowFrames). It only reads the page.
function vFrameState(app) {
	const ws = app.workspace.containerEl;
	const root = app.workspace.rootSplit;
	const strip = Array.from(ws.children).some((c) => c.classList.contains('tabstrip-vstrip'));
	const cls = ws.classList.contains('tabstrip-vertical');
	let native = 0;
	let tabs = 0;
	if (root && root.containerEl && root.containerEl.isConnected) {
		// Shown: laid out and not visibility: hidden (step V6: during a row drag the strip gives a stacked
		// pane's hidden header row an invisible box; it is not shown).
		for (const c of root.containerEl.querySelectorAll('.workspace-tabs > .workspace-tab-header-container')) if (c.offsetHeight > 0 && getComputedStyle(c).visibility !== 'hidden') native++;
		tabs = root.containerEl.querySelectorAll('.workspace-tabs').length;
	}
	const rows = ws.querySelectorAll('.tabstrip-vstrip .tabstrip-vrow').length;
	const bad = cls !== strip ? 'class-strip-mismatch' : strip && native > 0 ? 'strip-and-native' : !strip && native === 0 && tabs > 0 ? 'no-tab-ui' : null;
	return { strip, cls, native, tabs, rows, bad };
}
window.__tabstripVFrameState = vFrameState;

function watchVFrames(app) {
	let stored = null;
	try {
		stored = app.loadLocalStorage('tabstrip-session-v1');
	} catch {
		stored = null;
	}
	const record = { started: performance.now(), storedVertical: !!stored && stored.orientation === 'vertical', frames: 0, firstRootFrame: null, firstStripFrame: null, firstRowsFrame: null, nativeFrames: 0, emptyRowFrames: 0, bad: [], errors: 0 };
	window.__tabstripVFrames = record;
	const frame = () => {
		try {
			record.frames++;
			const st = vFrameState(app);
			if (st.tabs > 0 && record.firstRootFrame === null) record.firstRootFrame = record.frames;
			if (st.strip && record.firstStripFrame === null) record.firstStripFrame = record.frames;
			if (st.rows > 0 && record.firstRowsFrame === null) record.firstRowsFrame = record.frames;
			if (st.native > 0) record.nativeFrames++;
			// Not a bad frame (the strip is there), but an empty tab list while the root split has tabs.
			if (st.strip && st.rows === 0 && st.tabs > 0) record.emptyRowFrames++;
			if (st.bad && record.bad.length < 50) record.bad.push({ frame: record.frames, ms: performance.now() - record.started, ...st });
		} catch {
			record.errors++;
		}
		if (performance.now() - record.started < WATCH_MS) window.requestAnimationFrame(frame);
	};
	window.requestAnimationFrame(frame);
}

module.exports = class StartupLogProbe extends Plugin {
	onload() {
		console.info('e2e-startup-probe info');
		console.error('e2e-startup-probe error');
		watchConsole();
		// Positive control for the hook: the restart cases expect exactly one.
		console.error('e2e-startup-hook control');
		trackResizeObservers();
		watchFrames(this.app);
		watchVFrames(this.app);
	}
};
