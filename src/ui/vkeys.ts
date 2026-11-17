/**
 * Keyboard logic of the vertical strip's tree (step V4), pure: which action a key press asks for on
 * the focused item. No page access here; the strip (vstrip.ts) carries the actions out.
 *
 * Keys (requirements 5.2, WAI-ARIA tree pattern):
 * - Arrow Up / Down: previous / next item; Home / End: first / last item.
 * - Arrow Right: on a collapsed group, expand it; on an expanded group, go to its first member.
 * - Arrow Left: on an expanded group, collapse it; on a member, go to its group row.
 * - Enter: a tab is shown; a group row toggles; "New tab" makes a tab.
 * - Space: toggles the focused group (on a tab: shows it, like Enter).
 * - Delete (or Backspace on macOS keyboards without Delete): closes the focused tab.
 * - F2: renames the focused group (or the group of the focused member).
 * - Shift+F10 or the context-menu key: opens the item's right-click menu.
 * - Alt+Arrow Up / Down on a tab (step V5): moves the tab one row up / down, the keyboard's drag
 *   (src/core/drag.ts stepTarget); the focus stays on it.
 * IME composition never triggers anything; other keys with Ctrl, Alt or Meta are left to Obsidian.
 */

export interface VKeyItem {
	readonly kind: 'tab' | 'group' | 'new';
	readonly level: number;
	/** Group rows: collapsed. */
	readonly collapsed?: boolean;
}

export interface VKeyPress {
	readonly key: string;
	readonly shiftKey?: boolean;
	readonly ctrlKey?: boolean;
	readonly altKey?: boolean;
	readonly metaKey?: boolean;
	readonly isComposing?: boolean;
	/** 229 while an IME composes (some browsers report it with key 'Process'). */
	readonly keyCode?: number;
}

export type VKeyAction =
	| { readonly kind: 'focus'; readonly index: number }
	| { readonly kind: 'activate' }
	| { readonly kind: 'toggle' }
	| { readonly kind: 'expand' }
	| { readonly kind: 'collapse' }
	| { readonly kind: 'close' }
	| { readonly kind: 'rename' }
	| { readonly kind: 'menu' }
	| { readonly kind: 'newTab' }
	| { readonly kind: 'move'; readonly dir: -1 | 1 };

/** True while an input method is composing: such key presses belong to the IME. */
export function composing(evt: VKeyPress): boolean {
	return evt.isComposing === true || evt.key === 'Process' || evt.keyCode === 229;
}

/**
 * The action for a key press on item `index` of the visible `items` (list order), or null when the
 * key is not the strip's (it is then left alone, not prevented).
 */
export function keyAction(items: readonly VKeyItem[], index: number, evt: VKeyPress): VKeyAction | null {
	if (composing(evt)) return null;
	const item = items[index];
	if (item === undefined) return null;
	if (evt.key === 'ContextMenu' || (evt.key === 'F10' && evt.shiftKey === true)) {
		return evt.ctrlKey === true || evt.altKey === true || evt.metaKey === true ? null : { kind: 'menu' };
	}
	if (evt.altKey === true && evt.ctrlKey !== true && evt.metaKey !== true && evt.shiftKey !== true && (evt.key === 'ArrowUp' || evt.key === 'ArrowDown')) {
		return item.kind === 'tab' ? { kind: 'move', dir: evt.key === 'ArrowUp' ? -1 : 1 } : null;
	}
	if (evt.ctrlKey === true || evt.altKey === true || evt.metaKey === true || evt.shiftKey === true) return null;
	const last = items.length - 1;
	switch (evt.key) {
		case 'ArrowDown':
			return { kind: 'focus', index: Math.min(last, index + 1) };
		case 'ArrowUp':
			return { kind: 'focus', index: Math.max(0, index - 1) };
		case 'Home':
			return { kind: 'focus', index: 0 };
		case 'End':
			return { kind: 'focus', index: last };
		case 'ArrowRight':
			if (item.kind !== 'group') return null;
			if (item.collapsed === true) return { kind: 'expand' };
			return items[index + 1]?.level === 2 ? { kind: 'focus', index: index + 1 } : null;
		case 'ArrowLeft':
			if (item.kind === 'group') return item.collapsed === true ? null : { kind: 'collapse' };
			if (item.level === 2) {
				for (let i = index - 1; i >= 0; i--) if (items[i]?.kind === 'group') return { kind: 'focus', index: i };
			}
			return null;
		case 'Enter':
			return item.kind === 'tab' ? { kind: 'activate' } : item.kind === 'group' ? { kind: 'toggle' } : { kind: 'newTab' };
		case ' ':
		case 'Spacebar':
			return item.kind === 'tab' ? { kind: 'activate' } : item.kind === 'group' ? { kind: 'toggle' } : { kind: 'newTab' };
		case 'Delete':
		case 'Backspace':
			return item.kind === 'tab' ? { kind: 'close' } : null;
		case 'F2':
			if (item.kind === 'group') return { kind: 'rename' };
			if (item.kind === 'tab' && item.level === 2) return { kind: 'rename' };
			return null;
		default:
			return null;
	}
}

/**
 * The item that keeps the tab stop (roving tabindex) after the list changed: the item with the same
 * key, else the one now at the same place (clamped), else the highlighted tab; -1 for an empty list.
 */
export function rovingIndex(keys: readonly string[], focusKey: string | null, focusIndex: number, activeIndex: number): number {
	if (keys.length === 0) return -1;
	if (focusKey !== null) {
		const same = keys.indexOf(focusKey);
		if (same >= 0) return same;
		if (focusIndex >= 0) return Math.min(focusIndex, keys.length - 1);
	}
	return activeIndex >= 0 && activeIndex < keys.length ? activeIndex : 0;
}
