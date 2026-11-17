import { describe, expect, it } from 'vitest';
import { GROUP_COLORS } from '../../src/core/types';
import { localeFor, MESSAGES, translator } from '../../src/i18n';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n table', () => {
	it('has every key in English and Simplified Chinese, with the same placeholders', () => {
		const en = MESSAGES.en;
		const zh = MESSAGES.zh;
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
		for (const key of Object.keys(en) as (keyof typeof en)[]) {
			expect(zh[key].trim().length, key).toBeGreaterThan(0);
			expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
		}
	});

	it('names all nine colours in both languages', () => {
		for (const locale of ['en', 'zh'] as const) {
			const t = translator(locale);
			const names = GROUP_COLORS.map((c) => t.colorName(c));
			expect(new Set(names).size).toBe(9);
		}
	});

	it('uses sentence case for English menu items and commands', () => {
		for (const [key, text] of Object.entries(MESSAGES.en)) {
			if (!/^(tabMenu|chipMenu|command)\./.test(key)) continue;
			const words = text.replace(/\{\w+\}/g, '').split(/\s+/).slice(1);
			expect(words.filter((w) => /^[A-Z][a-z]/.test(w)), `${key}: ${text}`).toEqual([]);
		}
	});

	it('does not repeat the plugin name in command titles (Obsidian shows "Tabstrip: " in front)', () => {
		for (const locale of ['en', 'zh'] as const) {
			for (const [key, text] of Object.entries(MESSAGES[locale])) {
				if (key.startsWith('command.')) expect(text, `${locale} ${key}`).not.toMatch(/tabstrip/i);
			}
		}
		expect(MESSAGES.en['command.clearData']).toBe('Clear data on this device');
		expect(MESSAGES.zh['command.clearData']).toBe('清除本机数据');
	});

	it('quotes only real command titles in notices and dialogs', () => {
		for (const locale of ['en', 'zh'] as const) {
			const table = MESSAGES[locale];
			const titles = new Set(Object.entries(table).filter(([key]) => key.startsWith('command.')).map(([, text]) => text));
			let quoted = 0;
			for (const [key, text] of Object.entries(table)) {
				if (!/^(notice|clear)\./.test(key)) continue;
				for (const m of text.matchAll(/"([^"]+)"|「([^」]+)」/g)) {
					quoted++;
					expect(titles.has(m[1] ?? m[2] ?? ''), `${locale} ${key}: ${m[0]}`).toBe(true);
				}
			}
			// Positive control: the notices do quote commands ("Clear data on this device", "Restore unmatched groups").
			expect(quoted).toBe(3);
		}
	});
});

describe('localeFor (Obsidian language code)', () => {
	it.each([
		['zh', 'zh'],
		['zh-CN', 'zh'],
		['zh_cn', 'zh'],
		['zh-Hans', 'zh'],
		['zh-TW', 'en'],
		['en', 'en'],
		['de', 'en'],
		['', 'en'],
	])('%s -> %s', (code, locale) => {
		expect(localeFor(code)).toBe(locale);
	});
});

describe('translator', () => {
	it('fills placeholders and labels unnamed groups by colour', () => {
		const en = translator('en');
		expect(en.t('tabMenu.addToGroup', { label: '研究' })).toBe('Add tab to group: 研究');
		expect(en.groupLabel('  ', 'blue')).toBe('Blue group');
		expect(en.chipLabel('Work', 'red', 1)).toBe('Work, 1 tab');
		expect(en.chipLabel('', 'cyan', 3)).toBe('Cyan group, 3 tabs');
		const zh = translator('zh');
		expect(zh.chipLabel('研究', 'blue', 2)).toBe('研究，2 个标签');
		expect(zh.groupLabel('', 'green')).toBe('绿色组');
		// Collapsed groups (step L5): "name, N tabs, collapsed".
		expect(en.chipLabel('Work', 'red', 3, true)).toBe('Work, 3 tabs, collapsed');
		expect(en.chipLabel('Work', 'red', 3, false)).toBe('Work, 3 tabs');
		expect(zh.chipLabel('研究', 'blue', 2, true)).toBe('研究，2 个标签，已折叠');
		expect(zh.chipLabel('', 'green', 1, true)).toBe('绿色组，1 个标签，已折叠');
		// Unknown placeholders stay visible instead of disappearing.
		expect(en.t('tabMenu.addToGroup')).toBe('Add tab to group: {label}');
	});
});
