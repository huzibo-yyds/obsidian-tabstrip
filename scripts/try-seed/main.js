// Development only: `npm run try -- --vertical` installs this plugin next to Tabstrip in the
// throwaway sandbox vault. Once per vault (a marker in the app's local storage) it opens a few
// notes, makes three tab groups (one collapsed), pins one tab and switches Tabstrip to vertical
// tabs, so the vertical strip has something to show. It uses Tabstrip's command and its debug
// hooks (the same paths as the group menu); it never runs in the user's own vault.
const { Plugin } = require('obsidian');

const MARKER = 'tabstrip-try-seeded';
const NOTES = ['Getting Started.md', '欢迎.md', '会议记录（2026-11-08）.md', '项目/计划.md', 'Inbox.md', '读书笔记：深度学习.md', '中文 English 混合 note.md', 'Daily/2026-11-08.md'];

module.exports = class TabstripTrySeed extends Plugin {
	onload() {
		this.app.workspace.onLayoutReady(() => {
			void this.seed();
		});
	}

	async seed() {
		const app = this.app;
		if (app.loadLocalStorage(MARKER)) return;
		// Wait until Tabstrip has started (its controller reads the features at layout ready).
		let tabstrip = null;
		for (let i = 0; i < 100; i++) {
			tabstrip = app.plugins.plugins['tabstrip'];
			if (tabstrip && tabstrip.debug && tabstrip.debug.features()) break;
			await new Promise((r) => window.setTimeout(r, 100));
		}
		if (!tabstrip || !tabstrip.debug || !tabstrip.debug.features()) {
			console.warn('tabstrip-try-seed: Tabstrip did not start; nothing seeded');
			return;
		}
		const ids = [];
		let first = true;
		for (const path of NOTES) {
			const file = app.vault.getFileByPath(path);
			if (!file) continue;
			const leaf = first ? app.workspace.getLeaf(false) : app.workspace.getLeaf('tab');
			first = false;
			await leaf.openFile(file, { active: false });
			ids.push(leaf.id);
		}
		if (ids.length < 8) {
			console.warn('tabstrip-try-seed: not all notes found; nothing seeded');
			return;
		}
		// Tabstrip's test-setup hooks work only with this flag on the main window (src/test-hooks.ts).
		window.tabstripTestHooks = true;
		const d = tabstrip.debug;
		d.flush();
		d.group([ids[1], ids[2]], '项目 Project', 'blue');
		d.group([ids[3], ids[4]], '阅读 Reading', 'green');
		const archive = d.group([ids[6], ids[7]], '归档 Archive', 'grey');
		app.workspace.getLeafById(ids[0])?.setPinned(true);
		app.workspace.setActiveLeaf(app.workspace.getLeafById(ids[5]), { focus: true });
		d.flush();
		if (archive) d.setCollapsed(archive, true);
		if (d.orientation() !== 'vertical') app.commands.executeCommandById('tabstrip:toggle-vertical-tabs');
		d.flushSave();
		app.saveLocalStorage(MARKER, '1');
	}
};
