/**
 * Spike S1 (step L2). Throwaway feasibility test, NOT product code.
 *
 * Question: can a group "chip" that lives inside the FIRST member tab's header survive Obsidian's
 * own tab header refreshes, and can it keep its mouse events away from that tab?
 *
 * Mechanism under test (requirements 7.2):
 *  - the chip is a plugin-owned div appended as a child of the first member's `leaf.tabHeaderEl`;
 *  - CSS (styles.css) places it in that header's inline-start margin; the margin width is the
 *    measured chip width, written as a `--` custom property with setCssProps;
 *  - member headers get classes and data attributes;
 *  - decoration is re-applied on the workspace 'layout-change' event (needed when undo-close
 *    creates a new leaf object with a new header).
 *
 * Private members used (requirements 7.4 whitelist only): `leaf.id`, `leaf.tabHeaderEl`,
 * `WorkspaceTabs.children` / `currentTab`, and the native move recipe
 * removeChild -> setDimension(null) -> insertChild -> selectTabIndex -> requestResize.
 * No prototype patching, no innerHTML, no literal el.style writes, no network.
 *
 * Measuring (rects, hit tests, computed styles) is done by the e2e spec, not here.
 */
import { Menu, Plugin, WorkspaceTabs, type WorkspaceLeaf } from 'obsidian';

export const CHIP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type ChipColor = (typeof CHIP_COLORS)[number];

/** Private members of a leaf (whitelisted). */
interface LeafPrivate {
	readonly id: string;
	readonly tabHeaderEl: HTMLElement;
	setDimension(dimension: number | null): void;
}

/** Private members of a tab strip (whitelisted). */
interface TabsPrivate {
	readonly children: WorkspaceLeaf[];
	readonly currentTab: number;
	removeChild(leaf: WorkspaceLeaf): void;
	insertChild(index: number, leaf: WorkspaceLeaf): void;
	selectTabIndex(index: number): void;
}

interface WorkspacePrivate {
	requestResize(): void;
}

interface SpikeGroup {
	readonly id: string;
	readonly name: string;
	readonly color: ChipColor;
	readonly memberIds: readonly string[];
}

export type ChipEventName = 'click' | 'auxclick' | 'mousedown' | 'contextmenu' | 'mouseover' | 'dragstart' | 'dblclick';

export interface SpikeStats {
	/** Decoration passes, by any trigger. */
	passes: number;
	/** 'layout-change' events seen. */
	layoutChanges: number;
	/** Chips this plugin had to create (first decoration, chip moved to another header, or header replaced). */
	chipsCreated: number;
	chipsRemoved: number;
	/**
	 * Member classes / attributes the plugin had to (re)write on a header. Unchanged across an
	 * operation = Obsidian kept them on the header.
	 */
	memberWrites: number;
	/** Undo-closed members put back at their old index with the native move recipe. */
	restores: { id: string; nativeIndex: number; restoredIndex: number }[];
	/** Mouse events that reached the chip. */
	chipEvents: Record<ChipEventName, number>;
	/** Plugin menus opened from the chip. */
	chipMenus: number;
}

/** Class and attribute names, shared with the spec. */
export const SPIKE = {
	memberClass: 'tabstrip-member',
	hasChipClass: 'tabstrip-has-chip',
	chipClass: 'tabstrip-chip',
	chipLabelClass: 'tabstrip-chip-label',
	groupAttr: 'data-tabstrip-group',
	leafAttr: 'data-tabstrip-leaf',
	serialAttr: 'data-serial',
	slotProp: '--tabstrip-chip-slot',
	menuTitle: 'Spike chip menu',
} as const;

/** Space between the chip and the tab, on each side, in px (keep in sync with styles.css). */
const CHIP_GAP = 3;

export default class TabstripSpikeS1 extends Plugin {
	private group: SpikeGroup | null = null;
	private serial = 0;
	private readonly chips = new Set<HTMLElement>();
	private readonly chipObservers = new Map<HTMLElement, ResizeObserver>();
	/** Last index of each member in its strip, from the last pass. */
	private readonly positions = new Map<string, number>();
	/** Members that disappeared (closed), with their last index. */
	private readonly closed = new Map<string, number>();
	private restoring = false;

	readonly stats: SpikeStats = {
		passes: 0,
		layoutChanges: 0,
		chipsCreated: 0,
		chipsRemoved: 0,
		memberWrites: 0,
		restores: [],
		chipEvents: { click: 0, auxclick: 0, mousedown: 0, contextmenu: 0, mouseover: 0, dragstart: 0, dblclick: 0 },
		chipMenus: 0,
	};

	override onload(): void {
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.stats.layoutChanges++;
				this.decorate();
			}),
		);
		this.app.workspace.onLayoutReady(() => this.decorate());
	}

	override onunload(): void {
		this.group = null;
		for (const chip of [...this.chips]) this.removeChip(chip);
		for (const tabs of this.rootStrips()) {
			for (const leaf of tabs.children) {
				const header = (leaf as unknown as LeafPrivate).tabHeaderEl;
				this.clearMember(header);
				header.removeAttribute(SPIKE.leafAttr);
			}
		}
	}

	// ---- API used by the e2e spec ----

	/** Makes one group out of these leaves (by leaf id) and decorates. */
	setGroup(memberIds: readonly string[], name: string, color: ChipColor): void {
		this.group = { id: 'spike-group-1', name, color, memberIds: [...memberIds] };
		this.positions.clear();
		this.closed.clear();
		this.decorate();
	}

	/** Moves a leaf inside its own strip with the native move recipe (keeps the shown tab). */
	moveLeafById(id: string, toIndex: number): void {
		const leaf = this.app.workspace.getLeafById(id);
		if (!leaf) throw new Error(`no leaf ${id}`);
		this.moveLeaf(leaf, toIndex);
	}

	/** A copy of the counters. */
	readStats(): SpikeStats {
		return JSON.parse(JSON.stringify(this.stats)) as SpikeStats;
	}

	// ---- decoration ----

	private rootStrips(): TabsPrivate[] {
		const found = new Set<WorkspaceTabs>();
		this.app.workspace.iterateRootLeaves((leaf) => {
			if (leaf.parent instanceof WorkspaceTabs) found.add(leaf.parent);
		});
		return [...found].map((t) => t as unknown as TabsPrivate);
	}

	private decorate(): void {
		this.stats.passes++;
		const group = this.group;
		if (group && !this.restoring) this.restoreReturningMembers(group);

		const firstHeaders = new Set<HTMLElement>();
		const seen = new Set<string>();
		for (const tabs of this.rootStrips()) {
			let first: HTMLElement | undefined;
			for (const [index, leaf] of tabs.children.entries()) {
				const { id, tabHeaderEl: header } = leaf as unknown as LeafPrivate;
				seen.add(id);
				// Test aid: lets the spec find a header by leaf id.
				if (header.getAttribute(SPIKE.leafAttr) !== id) header.setAttribute(SPIKE.leafAttr, id);
				if (group?.memberIds.includes(id)) {
					this.positions.set(id, index);
					this.markMember(header, group);
					first ??= header;
				} else {
					this.clearMember(header);
				}
			}
			if (first) firstHeaders.add(first);
		}

		if (group) {
			for (const id of group.memberIds) {
				const last = this.positions.get(id);
				if (!seen.has(id) && last !== undefined) {
					this.closed.set(id, last);
					this.positions.delete(id);
				}
			}
		}

		// Exactly one chip per strip, in the first member's header.
		for (const chip of [...this.chips]) {
			const host = chip.parentElement;
			if (!host || !firstHeaders.has(host)) this.removeChip(chip);
		}
		for (const header of firstHeaders) {
			if (group && !header.querySelector(`:scope > .${SPIKE.chipClass}`)) this.createChip(header, group);
		}
	}

	/** A closed member whose leaf id is back (native undo-close) returns to its old index. */
	private restoreReturningMembers(group: SpikeGroup): void {
		if (this.closed.size === 0) return;
		for (const tabs of this.rootStrips()) {
			for (const [id, index] of [...this.closed]) {
				const leaf = tabs.children.find((l) => (l as unknown as LeafPrivate).id === id);
				if (!leaf || !group.memberIds.includes(id)) continue;
				this.closed.delete(id);
				const nativeIndex = tabs.children.indexOf(leaf);
				const target = Math.min(index, tabs.children.length - 1);
				if (nativeIndex !== target) {
					this.restoring = true;
					try {
						this.moveLeaf(leaf, target);
					} finally {
						this.restoring = false;
					}
				}
				this.stats.restores.push({ id, nativeIndex, restoredIndex: tabs.children.indexOf(leaf) });
			}
		}
	}

	/** Native move recipe (whitelisted): removeChild -> setDimension(null) -> insertChild -> selectTabIndex -> requestResize. */
	private moveLeaf(leaf: WorkspaceLeaf, toIndex: number): void {
		if (!(leaf.parent instanceof WorkspaceTabs)) throw new Error('leaf is not in a tab strip');
		const tabs = leaf.parent as unknown as TabsPrivate;
		const shown = tabs.children[tabs.currentTab];
		tabs.removeChild(leaf);
		(leaf as unknown as LeafPrivate).setDimension(null);
		tabs.insertChild(toIndex, leaf);
		tabs.selectTabIndex(shown ? tabs.children.indexOf(shown) : toIndex);
		(this.app.workspace as unknown as WorkspacePrivate).requestResize();
	}

	private markMember(header: HTMLElement, group: SpikeGroup): void {
		const colorClass = `tabstrip-color-${group.color}`;
		if (!header.hasClass(SPIKE.memberClass)) {
			header.addClass(SPIKE.memberClass);
			this.stats.memberWrites++;
		}
		if (!header.hasClass(colorClass)) {
			header.addClass(colorClass);
			this.stats.memberWrites++;
		}
		if (header.getAttribute(SPIKE.groupAttr) !== group.id) {
			header.setAttribute(SPIKE.groupAttr, group.id);
			this.stats.memberWrites++;
		}
	}

	private clearMember(header: HTMLElement): void {
		header.removeClass(SPIKE.memberClass, ...CHIP_COLORS.map((c) => `tabstrip-color-${c}`));
		header.removeAttribute(SPIKE.groupAttr);
	}

	private createChip(header: HTMLElement, group: SpikeGroup): void {
		const chip = header.createDiv({
			cls: [SPIKE.chipClass, `tabstrip-color-${group.color}`],
			attr: {
				role: 'button',
				'aria-label': `${group.name}, ${group.memberIds.length} tabs`,
				[SPIKE.serialAttr]: String(++this.serial),
				draggable: 'false',
			},
		});
		chip.createSpan({ cls: SPIKE.chipLabelClass, text: group.name });
		header.addClass(SPIKE.hasChipClass);
		this.shield(chip);

		// The header's inline-start margin must be as wide as the chip (CJK text and late font loads
		// change the width, hence the observer).
		const observer = new ResizeObserver(() => this.updateSlot(chip));
		observer.observe(chip);
		this.chipObservers.set(chip, observer);
		this.chips.add(chip);
		this.updateSlot(chip);
		this.stats.chipsCreated++;
	}

	private updateSlot(chip: HTMLElement): void {
		const header = chip.parentElement;
		if (!header) return;
		const width = chip.getBoundingClientRect().width;
		if (width > 0) header.setCssProps({ [SPIKE.slotProp]: `${Math.ceil(width) + 2 * CHIP_GAP}px` });
	}

	private removeChip(chip: HTMLElement): void {
		this.chipObservers.get(chip)?.disconnect();
		this.chipObservers.delete(chip);
		const header = chip.parentElement;
		if (header) {
			header.removeClass(SPIKE.hasChipClass);
			header.setCssProps({ [SPIKE.slotProp]: '' });
		}
		chip.remove();
		this.chips.delete(chip);
		this.stats.chipsRemoved++;
	}

	/**
	 * Keeps the chip's mouse events away from the tab header it lives in. The header and its strip
	 * listen in the bubble phase, so stopping the event at the chip is enough:
	 *  - click: the strip selects the tab whose header was clicked;
	 *  - auxclick: a middle-button auxclick on a header closes the tab;
	 *  - contextmenu: the header opens the tab menu;
	 *  - mouseover: the header asks for a page preview unless the event is default-prevented
	 *    (propagation is kept, so other listeners still see the pointer);
	 *  - dragstart: the header is draggable;
	 *  - dblclick: on macOS without a window frame, a double click on the strip zooms the window.
	 */
	private shield(chip: HTMLElement): void {
		const count = (name: ChipEventName) => {
			this.stats.chipEvents[name]++;
		};
		const stop = (evt: Event) => {
			evt.preventDefault();
			evt.stopPropagation();
		};
		chip.addEventListener('click', (evt) => {
			count('click');
			stop(evt);
		});
		chip.addEventListener('auxclick', (evt) => {
			count('auxclick');
			stop(evt);
		});
		chip.addEventListener('mousedown', (evt) => {
			count('mousedown');
			// No autoscroll cursor on middle press (the header does the same for itself).
			if (evt.button === 1) evt.preventDefault();
		});
		chip.addEventListener('contextmenu', (evt) => {
			count('contextmenu');
			stop(evt);
			this.openChipMenu(evt);
		});
		chip.addEventListener('mouseover', (evt) => {
			count('mouseover');
			evt.preventDefault();
		});
		chip.addEventListener('dragstart', (evt) => {
			count('dragstart');
			stop(evt);
		});
		chip.addEventListener('dblclick', (evt) => {
			count('dblclick');
			stop(evt);
		});
	}

	private openChipMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.setUseNativeMenu(false);
		menu.addItem((item) => item.setTitle(SPIKE.menuTitle).setIcon('tag'));
		menu.showAtMouseEvent(evt);
		this.stats.chipMenus++;
	}
}
