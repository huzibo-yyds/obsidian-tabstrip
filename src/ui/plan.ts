/**
 * Pure part of the horizontal decoration: which tab header gets which marks.
 *
 * Every member header gets the group colour and an underline segment; the first member of
 * a group in a strip also carries the chip (requirements 7.2: a chip can only live inside
 * a tab header). Members of a collapsed group are hidden (step L5), except in stacked strips,
 * which never hide tabs. No page access here.
 */
import type { GroupColor, GroupState } from '../core/types';

export interface ChipPlan {
	readonly groupId: string;
	readonly name: string;
	readonly color: GroupColor;
	/** Members of the group in this strip. */
	readonly count: number;
	/** The group is collapsed and its strip hides tabs (not stacked): only the chip shows. */
	readonly collapsed: boolean;
}

export interface HeaderPlan {
	readonly groupId: string;
	readonly color: GroupColor;
	readonly chip: ChipPlan | null;
	/** Hidden member of a collapsed group (width 0, invisible); the chip holder keeps its chip. */
	readonly collapsed: boolean;
}

export interface StripOrder {
	readonly leaves: readonly { readonly id: string }[];
	/** Stacked tabs never hide tabs: a collapsed group there shows its colour only. */
	readonly stacked?: boolean;
}

/** Leaf id → marks for its header. Leaves that are not members are absent. */
export function planDecorations(strips: readonly StripOrder[], state: GroupState): Map<string, HeaderPlan> {
	const plan = new Map<string, HeaderPlan>();
	if (state.groups.length === 0) return plan;
	const groups = new Map(state.groups.map((g) => [g.id, g]));
	const memberOf = new Map<string, string>();
	for (const m of state.members) if (groups.has(m.groupId)) memberOf.set(m.leafId, m.groupId);

	for (const strip of strips) {
		const counts = new Map<string, number>();
		for (const leaf of strip.leaves) {
			const groupId = memberOf.get(leaf.id);
			if (groupId !== undefined) counts.set(groupId, (counts.get(groupId) ?? 0) + 1);
		}
		const withChip = new Set<string>();
		for (const leaf of strip.leaves) {
			const groupId = memberOf.get(leaf.id);
			const group = groupId === undefined ? undefined : groups.get(groupId);
			if (groupId === undefined || group === undefined || plan.has(leaf.id)) continue;
			const collapsed = group.collapsed && strip.stacked !== true;
			let chip: ChipPlan | null = null;
			if (!withChip.has(groupId)) {
				withChip.add(groupId);
				chip = { groupId, name: group.name, color: group.color, count: counts.get(groupId) ?? 1, collapsed };
			}
			plan.set(leaf.id, { groupId, color: group.color, chip, collapsed });
		}
	}
	return plan;
}

/** Stable text form of a header's marks, used to skip DOM writes when nothing changed. */
export function planKey(plan: HeaderPlan | undefined, chipLabel: string, ink: string): string {
	if (plan === undefined) return '';
	const base = `${plan.groupId}|${plan.color}${plan.collapsed ? '|collapsed' : ''}`;
	if (plan.chip === null) return base;
	return `${base}|chip|${plan.chip.name}|${String(plan.chip.count)}|${chipLabel}|${ink}`;
}
