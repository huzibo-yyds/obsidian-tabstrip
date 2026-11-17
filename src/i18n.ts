/**
 * Every user-visible string of the plugin, in English and Simplified Chinese.
 *
 * This file must not import `obsidian`: the caller passes the app language in, so the
 * table and the lookup can be unit-tested. Placeholders are written `{name}`.
 */
import type { GroupColor } from './core/types';

export type Locale = 'en' | 'zh';

const en = {
	'color.grey': 'Grey',
	'color.blue': 'Blue',
	'color.red': 'Red',
	'color.yellow': 'Yellow',
	'color.green': 'Green',
	'color.pink': 'Pink',
	'color.purple': 'Purple',
	'color.cyan': 'Cyan',
	'color.orange': 'Orange',
	/** Label of a group without a name. */
	'group.unnamed': '{color} group',
	/** Accessible name of the chip. */
	'chip.label.one': '{label}, 1 tab',
	'chip.label.many': '{label}, {count} tabs',
	/** Accessible name of a collapsed group's chip. */
	'chip.label.collapsed': '{label}, collapsed',
	'tabMenu.addToNewGroup': 'Add tab to new group',
	'tabMenu.addToGroup': 'Add tab to group: {label}',
	'tabMenu.removeFromGroup': 'Remove from group',
	'chipMenu.rename': 'Rename group',
	'chipMenu.newTab': 'New tab in group',
	'chipMenu.ungroup': 'Ungroup',
	'chipMenu.closeGroup': 'Close group',
	'chipMenu.collapseOthers': 'Collapse other groups',
	'editor.title': 'Edit group',
	'editor.name': 'Group name',
	'editor.placeholder': 'Name this group',
	'editor.colors': 'Group color',
	'command.addToNewGroup': 'Add current tab to new group',
	'command.removeFromGroup': 'Remove current tab from group',
	'command.renameGroup': 'Rename current group',
	'command.restoreNative': 'Restore native tab bar',
	'command.showGroups': 'Show tab groups again',
	'command.nextTabSkip': 'Go to next tab (skip collapsed groups)',
	'command.previousTabSkip': 'Go to previous tab (skip collapsed groups)',
	'command.toggleCollapse': 'Collapse/expand current group',
	'notice.pinnedOut': 'Pinned tabs cannot be in a group. Left: {labels}',
	'notice.stackedNoCollapse': 'Groups cannot be collapsed in stacked tabs',
	'command.restoreUnmatched': 'Restore unmatched groups',
	'command.clearData': 'Clear data on this device',
	'notice.storeFuture': 'Tabstrip: the tab groups saved on this device come from a newer version of Tabstrip. They are kept unchanged; groups start empty until you update Tabstrip.',
	'notice.storeCorrupt':
		'Tabstrip: the saved tab groups could not be read. They are kept unchanged and tab groups are not saved on this device; run "Clear data on this device" to start saving again.',
	'notice.storePartial': 'Tabstrip: part of the saved tab group data could not be read and was skipped.',
	'notice.unmatchedAtStart': 'Tabstrip: tab groups without matching open tabs: {count}. Run "Restore unmatched groups" to try again.',
	'notice.unmatchedDropped': 'Tabstrip: the unmatched list keeps at most {limit} tab groups. The {count} oldest were removed to make room.',
	'notice.restoredUnmatched': 'Restored tab groups: {count}.',
	'notice.restoredUnmatchedPartial':
		'Restored tab groups: {count}. Tabs not found: {left}. They stay in the unmatched list; open their files and run "Restore unmatched groups" again.',
	'notice.nothingMatched': 'No open tabs match the unmatched tab groups ({count}).',
	'notice.noUnmatched': 'There are no unmatched tab groups.',
	'notice.unmatchedRefused': 'Tabstrip could not restore the unmatched tab groups here: their tabs would have to be moved, and moving tabs is not available. The groups stay in the unmatched list.',
	'notice.restoreFailed': 'Tabstrip: the saved tab groups could not be restored. They are kept unchanged; tab groups are not saved until Obsidian restarts.',
	'notice.cleared': 'Tabstrip data on this device was cleared.',
	'clear.title': 'Clear Tabstrip data on this device?',
	'clear.message':
		'This removes what Tabstrip saved on this device for this vault: open groups, recently closed groups, unmatched groups and the vertical tab bar settings (orientation, width, icon bar; this window keeps its current look; the next save, such as a change to a group or switching the orientation, stores them again; if nothing is saved before a restart, that restart starts horizontal). No tab is closed. Groups that are open now are saved again only after the next change to a group or a switch of the tab bar orientation; until then nothing is written, also after a restart.',
	'clear.confirm': 'Clear data',
	'clear.cancel': 'Cancel',
	'command.toggleVertical': 'Toggle vertical tabs (experimental)',
	'vstrip.label': 'Tabs',
	'vstrip.toggleLeft': 'Toggle left sidebar',
	'vstrip.toggleRight': 'Toggle right sidebar',
	'vstrip.treeLabel': 'Open tabs',
	'vstrip.collapse': 'Collapse tab strip',
	'vstrip.expand': 'Expand tab strip',
	'vstrip.resize': 'Resize tab strip',
	'vstrip.pinned': 'Pinned tabs',
	'vstrip.pane': 'Pane {index}',
	'vstrip.newTab': 'New tab',
	'vstrip.close': 'Close',
	'vstrip.pinnedTab': 'pinned',
	'vstrip.notLoaded': 'not loaded',
	'command.toggleStripCollapsed': 'Collapse/expand vertical tab strip',
	'command.moveTabBack': 'Move current tab up (left) one place',
	'command.moveTabForward': 'Move current tab down (right) one place',
	'notice.verticalTabsConflict':
		'Tabstrip: the Vertical Tabs plugin seems to be enabled. Both plugins change the tab bar, in horizontal and in vertical mode, so they overlap and can get in each other\'s way. Tabstrip leaves it enabled; consider disabling one of them.',
	'notice.verticalUnavailable': 'Tabstrip: vertical tabs are not available in this Obsidian version. The native tab bar stays.',
	'notice.moveFailed': 'Tabstrip: the tab could not be moved. Details are in the developer console.',
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
	'color.grey': '灰色',
	'color.blue': '蓝色',
	'color.red': '红色',
	'color.yellow': '黄色',
	'color.green': '绿色',
	'color.pink': '粉色',
	'color.purple': '紫色',
	'color.cyan': '青色',
	'color.orange': '橙色',
	'group.unnamed': '{color}组',
	'chip.label.one': '{label}，1 个标签',
	'chip.label.many': '{label}，{count} 个标签',
	'chip.label.collapsed': '{label}，已折叠',
	'tabMenu.addToNewGroup': '添加到新组',
	'tabMenu.addToGroup': '添加到组：{label}',
	'tabMenu.removeFromGroup': '移出组',
	'chipMenu.rename': '重命名组',
	'chipMenu.newTab': '在组内新建标签',
	'chipMenu.ungroup': '取消分组',
	'chipMenu.closeGroup': '关闭组',
	'chipMenu.collapseOthers': '折叠其他组',
	'editor.title': '编辑组',
	'editor.name': '组名',
	'editor.placeholder': '为这个组命名',
	'editor.colors': '组颜色',
	'command.addToNewGroup': '将当前标签添加到新组',
	'command.removeFromGroup': '将当前标签移出组',
	'command.renameGroup': '重命名当前组',
	'command.restoreNative': '恢复原生标签栏',
	'command.showGroups': '重新显示标签组',
	'command.nextTabSkip': '跳到下一个标签（跳过折叠的组）',
	'command.previousTabSkip': '跳到上一个标签（跳过折叠的组）',
	'command.toggleCollapse': '折叠/展开当前组',
	'notice.pinnedOut': '固定的标签不能留在组里，已移出：{labels}',
	'notice.stackedNoCollapse': '堆叠标签模式下不能折叠组',
	'command.restoreUnmatched': '恢复未匹配的组',
	'command.clearData': '清除本机数据',
	'notice.storeFuture': 'Tabstrip：本机保存的标签组来自更新版本的 Tabstrip，已原样保留。更新 Tabstrip 之前，这里先不显示这些组。',
	'notice.storeCorrupt': 'Tabstrip：保存的标签组读不出来，已原样保留，本机暂不保存标签组。运行「清除本机数据」后重新开始保存。',
	'notice.storePartial': 'Tabstrip：保存的标签组数据有一部分读不出来，已跳过。',
	'notice.unmatchedAtStart': 'Tabstrip：有 {count} 个标签组找不到对应的标签。可以运行「恢复未匹配的组」再试一次。',
	'notice.unmatchedDropped': 'Tabstrip：未匹配列表最多保留 {limit} 个标签组，为腾出位置删掉了最旧的 {count} 个。',
	'notice.restoredUnmatched': '已恢复 {count} 个标签组。',
	'notice.restoredUnmatchedPartial': '已恢复 {count} 个标签组。有 {left} 个标签没找到，仍留在未匹配列表里；打开它们的文件后再运行一次「恢复未匹配的组」。',
	'notice.nothingMatched': '没有打开的标签能对上未匹配的标签组（{count} 个）。',
	'notice.noUnmatched': '没有未匹配的标签组。',
	'notice.unmatchedRefused': 'Tabstrip：这里恢复不了未匹配的标签组，因为要移动标签，而移动标签的功能用不了。这些组仍留在未匹配列表里。',
	'notice.restoreFailed': 'Tabstrip：保存的标签组恢复失败，已原样保留。重启 Obsidian 之前不再保存标签组。',
	'notice.cleared': '已清除本机的 Tabstrip 数据。',
	'clear.title': '清除本机的 Tabstrip 数据？',
	'clear.message': '这会删除 Tabstrip 在本机为这个仓库保存的内容：已打开的组、最近关闭的组、未匹配的组，以及竖排标签栏的设置（方向、宽度、是否收起成图标栏；当前窗口保持现在的样子；之后只要再保存一次，比如改动标签组或切换方向，就会把这些设置重新存下来；重启前一次都没保存的话，重启后是横排）。不会关闭任何标签。现在打开的组要等下一次改动标签组或切换标签栏方向后才会重新保存；在那之前什么都不写，重启后也一样。',
	'clear.confirm': '清除数据',
	'clear.cancel': '取消',
	'command.toggleVertical': '切换垂直标签栏（实验）',
	'vstrip.label': '标签',
	'vstrip.toggleLeft': '展开/收起左侧边栏',
	'vstrip.toggleRight': '展开/收起右侧边栏',
	'vstrip.treeLabel': '已打开的标签',
	'vstrip.collapse': '收起标签栏',
	'vstrip.expand': '展开标签栏',
	'vstrip.resize': '调整标签栏宽度',
	'vstrip.pinned': '固定的标签',
	'vstrip.pane': '面板 {index}',
	'vstrip.newTab': '新建标签',
	'vstrip.close': '关闭',
	'vstrip.pinnedTab': '已固定',
	'vstrip.notLoaded': '未加载',
	'command.toggleStripCollapsed': '收起/展开垂直标签栏',
	'command.moveTabBack': '把当前标签往上（左）移一格',
	'command.moveTabForward': '把当前标签往下（右）移一格',
	'notice.verticalTabsConflict': 'Tabstrip：Vertical Tabs 插件好像已经启用。两个插件都会改标签栏，横排和竖排都会，功能重叠，可能互相干扰。Tabstrip 不会停用它，建议停用其中一个。',
	'notice.verticalUnavailable': 'Tabstrip：这个版本的 Obsidian 用不了垂直标签栏，继续使用原生标签栏。',
	'notice.moveFailed': 'Tabstrip：标签没能移动，详情见开发者控制台。',
};

export const MESSAGES: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { en, zh };

/** Obsidian language code (`getLanguage()`) → our locale. Traditional Chinese falls back to English. */
export function localeFor(language: string): Locale {
	const code = language.trim().toLowerCase().replace('_', '-');
	if (code === 'zh' || code === 'zh-cn' || code === 'zh-hans' || code.startsWith('zh-hans-')) return 'zh';
	return 'en';
}

export type Params = Readonly<Record<string, string | number>>;

export interface Translator {
	readonly locale: Locale;
	t(key: MessageKey, params?: Params): string;
	colorName(color: GroupColor): string;
	/** Name of the group, or "<Colour> group" when it has none. */
	groupLabel(name: string, color: GroupColor): string;
	/** Accessible name of a chip: "<label>, <n> tabs", plus ", collapsed" for a collapsed group. */
	chipLabel(name: string, color: GroupColor, count: number, collapsed?: boolean): string;
}

export function translator(locale: Locale): Translator {
	const table = MESSAGES[locale];
	const t = (key: MessageKey, params: Params = {}): string =>
		table[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
			const value = params[name];
			return value === undefined ? whole : String(value);
		});
	const colorName = (color: GroupColor): string => t(`color.${color}`);
	const groupLabel = (name: string, color: GroupColor): string => {
		const trimmed = name.trim();
		return trimmed.length > 0 ? trimmed : t('group.unnamed', { color: colorName(color) });
	};
	return {
		locale,
		t,
		colorName,
		groupLabel,
		chipLabel: (name, color, count, collapsed = false) => {
			const base = t(count === 1 ? 'chip.label.one' : 'chip.label.many', { label: groupLabel(name, color), count });
			return collapsed ? t('chip.label.collapsed', { label: base }) : base;
		},
	};
}
