/**
 * Items of the chip menu and of the group part of the native tab menu.
 *
 * Only `Menu`/`MenuItem` types are used (public API); the caller creates and shows the menu.
 * The tab menu items go into the 'pane' section, so they sit with Pin and "Move to new
 * window" instead of at the very end of Obsidian's tab menu.
 */
import type { Menu } from 'obsidian';
import { GROUP_COLORS, type GroupColor } from '../core/types';
import type { Translator } from '../i18n';

export interface ChipMenuActions {
	rename(): void;
	recolor(color: GroupColor): void;
	newTab(): void;
	ungroup(): void;
	close(): void;
	collapseOthers(): void;
}

export interface ChipMenuOptions {
	readonly color: GroupColor;
	/** "New tab in group" is available (capability `createLeaf`). */
	readonly newTab: boolean;
	/** "Rename group" is available (the editor bubble needs the chip). */
	readonly rename: boolean;
	/** Swatch for a colour item title (a fragment with a coloured dot and the colour name). */
	readonly swatchTitle: (color: GroupColor) => DocumentFragment | string;
	/**
	 * "Collapse other groups" (step L5): 'hidden' when the strip has no other group or cannot
	 * hide tabs (stacked), 'disabled' when every other group of the strip is already collapsed.
	 */
	readonly collapseOthers: 'enabled' | 'disabled' | 'hidden';
}

/**
 * Fills the chip menu: rename, the nine colours, new tab in group, ungroup, close group, and
 * (when the strip has other groups) collapse other groups.
 */
export function fillChipMenu(menu: Menu, t: Translator, options: ChipMenuOptions, actions: ChipMenuActions): void {
	if (options.rename) {
		menu.addItem((item) =>
			item
				.setSection('tabstrip-edit')
				.setTitle(t.t('chipMenu.rename'))
				.setIcon('pencil')
				.onClick(() => {
					actions.rename();
				}),
		);
	}
	for (const color of GROUP_COLORS) {
		menu.addItem((item) =>
			item
				.setSection('tabstrip-color')
				.setTitle(options.swatchTitle(color))
				.setChecked(color === options.color)
				.onClick(() => {
					actions.recolor(color);
				}),
		);
	}
	if (options.newTab) {
		menu.addItem((item) =>
			item
				.setSection('tabstrip-group')
				.setTitle(t.t('chipMenu.newTab'))
				.setIcon('plus')
				.onClick(() => {
					actions.newTab();
				}),
		);
	}
	menu.addItem((item) =>
		item
			.setSection('tabstrip-group')
			.setTitle(t.t('chipMenu.ungroup'))
			.setIcon('ungroup')
			.onClick(() => {
				actions.ungroup();
			}),
	);
	menu.addItem((item) =>
		item
			.setSection('tabstrip-group')
			.setTitle(t.t('chipMenu.closeGroup'))
			.setIcon('x')
			.onClick(() => {
				actions.close();
			}),
	);
	if (options.collapseOthers !== 'hidden') {
		menu.addItem((item) =>
			item
				.setSection('tabstrip-collapse')
				.setTitle(t.t('chipMenu.collapseOthers'))
				.setIcon('fold-horizontal')
				.setDisabled(options.collapseOthers === 'disabled')
				.onClick(() => {
					actions.collapseOthers();
				}),
		);
	}
}

export interface TabMenuGroup {
	readonly id: string;
	readonly name: string;
	readonly color: GroupColor;
}

export interface TabMenuActions {
	addToNewGroup(): void;
	addToGroup(groupId: string): void;
	removeFromGroup(): void;
}

/** Section of Obsidian's tab menu that holds Pin, Link with tab and Move to new window. */
export const TAB_MENU_SECTION = 'pane';

/**
 * Group items for the tab menu of one (unpinned, main-area or pop-out) tab: add to a new
 * group, add to each other group of the same strip (flat items; the public menu API has no
 * submenus), and remove from its group when it is a member.
 */
export function fillTabMenu(
	menu: Menu,
	t: Translator,
	options: { readonly member: boolean; readonly otherGroups: readonly TabMenuGroup[] },
	actions: TabMenuActions,
): void {
	menu.addItem((item) =>
		item
			.setSection(TAB_MENU_SECTION)
			.setTitle(t.t('tabMenu.addToNewGroup'))
			.setIcon('copy-plus')
			.onClick(() => {
				actions.addToNewGroup();
			}),
	);
	for (const group of options.otherGroups) {
		menu.addItem((item) =>
			item
				.setSection(TAB_MENU_SECTION)
				.setTitle(t.t('tabMenu.addToGroup', { label: t.groupLabel(group.name, group.color) }))
				.setIcon('folder-input')
				.onClick(() => {
					actions.addToGroup(group.id);
				}),
		);
	}
	if (options.member) {
		menu.addItem((item) =>
			item
				.setSection(TAB_MENU_SECTION)
				.setTitle(t.t('tabMenu.removeFromGroup'))
				.setIcon('log-out')
				.onClick(() => {
					actions.removeFromGroup();
				}),
		);
	}
}
