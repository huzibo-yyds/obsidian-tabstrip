import type { Menu } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { translator } from '../../../src/i18n';
import { fillChipMenu, fillTabMenu, TAB_MENU_SECTION } from '../../../src/ui/menus';

interface Item {
	section?: string;
	title?: string;
	checked?: boolean | null;
	disabled?: boolean;
	click?: () => void;
}

/** Records what the code adds to a menu (the public Menu/MenuItem calls only). */
function recordingMenu(): { menu: Menu; items: Item[] } {
	const items: Item[] = [];
	const menu = {
		addItem(cb: (item: unknown) => void) {
			const it: Item = {};
			const api = {
				setSection: (s: string) => ((it.section = s), api),
				setTitle: (t: string | DocumentFragment) => ((it.title = typeof t === 'string' ? t : '[fragment]'), api),
				setIcon: () => api,
				setChecked: (c: boolean | null) => ((it.checked = c), api),
				setDisabled: (d: boolean) => ((it.disabled = d), api),
				onClick: (f: () => void) => ((it.click = f), api),
			};
			cb(api);
			items.push(it);
			return menu;
		},
	};
	return { menu: menu as unknown as Menu, items };
}

describe('chip menu', () => {
	it('rename, nine colours with the current one checked, new tab, ungroup, close', () => {
		const { menu, items } = recordingMenu();
		const calls: string[] = [];
		fillChipMenu(
			menu,
			translator('en'),
			{ color: 'red', newTab: true, rename: true, swatchTitle: (c) => `swatch ${c}`, collapseOthers: 'hidden' },
			{
				rename: () => calls.push('rename'),
				recolor: (c) => calls.push(`recolor ${c}`),
				newTab: () => calls.push('newTab'),
				ungroup: () => calls.push('ungroup'),
				close: () => calls.push('close'),
				collapseOthers: () => calls.push('collapseOthers'),
			},
		);
		expect(items.map((i) => i.title)).toEqual([
			'Rename group',
			'swatch grey',
			'swatch blue',
			'swatch red',
			'swatch yellow',
			'swatch green',
			'swatch pink',
			'swatch purple',
			'swatch cyan',
			'swatch orange',
			'New tab in group',
			'Ungroup',
			'Close group',
		]);
		expect(items.filter((i) => i.checked === true).map((i) => i.title)).toEqual(['swatch red']);
		for (const i of items) i.click?.();
		expect(calls).toEqual([
			'rename',
			'recolor grey',
			'recolor blue',
			'recolor red',
			'recolor yellow',
			'recolor green',
			'recolor pink',
			'recolor purple',
			'recolor cyan',
			'recolor orange',
			'newTab',
			'ungroup',
			'close',
		]);
	});

	it('leaves out what is not available', () => {
		const { menu, items } = recordingMenu();
		const noop = () => undefined;
		fillChipMenu(menu, translator('zh'), { color: 'grey', newTab: false, rename: false, swatchTitle: (c) => c, collapseOthers: 'hidden' }, {
			rename: noop,
			recolor: noop,
			newTab: noop,
			ungroup: noop,
			close: noop,
			collapseOthers: noop,
		});
		expect(items.map((i) => i.title).slice(-2)).toEqual(['取消分组', '关闭组']);
		expect(items).toHaveLength(11);
	});

	it('"Collapse other groups" comes last when the strip has other groups, disabled when they are all collapsed', () => {
		const noop = () => undefined;
		const calls: string[] = [];
		const actions = { rename: noop, recolor: noop, newTab: noop, ungroup: noop, close: noop, collapseOthers: () => calls.push('others') };
		for (const [mode, disabled] of [['enabled', false], ['disabled', true]] as const) {
			const { menu, items } = recordingMenu();
			fillChipMenu(menu, translator('en'), { color: 'grey', newTab: true, rename: true, swatchTitle: (c) => c, collapseOthers: mode }, actions);
			const last = items[items.length - 1];
			expect(last).toMatchObject({ title: 'Collapse other groups', section: 'tabstrip-collapse', disabled });
			expect(items).toHaveLength(14);
			last?.click?.();
		}
		expect(calls).toEqual(['others', 'others']);
		const { menu, items } = recordingMenu();
		fillChipMenu(menu, translator('zh'), { color: 'grey', newTab: true, rename: true, swatchTitle: (c) => c, collapseOthers: 'enabled' }, actions);
		expect(items[items.length - 1]?.title).toBe('折叠其他组');
	});
});

describe('tab menu group items', () => {
	it('new group, one flat item per other group of the strip, and remove when a member', () => {
		const { menu, items } = recordingMenu();
		const calls: string[] = [];
		fillTabMenu(
			menu,
			translator('en'),
			{ member: true, otherGroups: [{ id: 'g2', name: '研究', color: 'blue' }, { id: 'g3', name: '', color: 'green' }] },
			{
				addToNewGroup: () => calls.push('new'),
				addToGroup: (id) => calls.push(`add ${id}`),
				removeFromGroup: () => calls.push('remove'),
			},
		);
		expect(items.map((i) => i.title)).toEqual([
			'Add tab to new group',
			'Add tab to group: 研究',
			'Add tab to group: Green group',
			'Remove from group',
		]);
		expect(new Set(items.map((i) => i.section))).toEqual(new Set([TAB_MENU_SECTION]));
		for (const i of items) i.click?.();
		expect(calls).toEqual(['new', 'add g2', 'add g3', 'remove']);
	});

	it('no remove item for a tab outside any group', () => {
		const { menu, items } = recordingMenu();
		const noop = () => undefined;
		fillTabMenu(menu, translator('en'), { member: false, otherGroups: [] }, { addToNewGroup: noop, addToGroup: noop, removeFromGroup: noop });
		expect(items.map((i) => i.title)).toEqual(['Add tab to new group']);
	});
});
