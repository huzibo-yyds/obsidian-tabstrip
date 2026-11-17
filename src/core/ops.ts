/**
 * Reference meaning of `Op`s: what the adapter is expected to do, as a pure function
 * on snapshots. Used by tests and to predict a layout before touching the workspace.
 *
 * `close` follows a simple model of Obsidian: the strip shows the right neighbour (or
 * the left one) of a closed shown tab, an emptied pop-out or split disappears, and the
 * last main strip gets a fresh empty tab. Obsidian itself may pick another tab to show.
 */
import type { LeafInfo, Op, PaneInfo, Snapshot } from './types';
import { at } from './util';

interface MutablePane {
	id: string;
	kind: PaneInfo['kind'];
	leaves: LeafInfo[];
	currentLeafId: string | null;
	stacked: boolean | undefined;
}

export class OpError extends Error {
	override name = 'OpError';
}

function locate(panes: readonly MutablePane[], leafId: string): { pane: MutablePane; index: number } {
	for (const pane of panes) {
		const index = pane.leaves.findIndex((l) => l.id === leafId);
		if (index >= 0) return { pane, index };
	}
	throw new OpError(`unknown leaf ${leafId}`);
}

function paneById(panes: readonly MutablePane[], paneId: string): MutablePane {
	const pane = panes.find((p) => p.id === paneId);
	if (pane === undefined) throw new OpError(`unknown pane ${paneId}`);
	return pane;
}

function checkIndex(index: number, max: number): void {
	if (!Number.isInteger(index) || index < 0 || index > max) throw new OpError(`index ${String(index)} out of range`);
}

/**
 * Applies ops in order and returns the resulting snapshot. Throws `OpError` when an op
 * refers to a leaf or strip that does not exist, uses an index out of range, or moves
 * a tab to another strip (the model never asks for that).
 */
export function applyOps(snapshot: Snapshot, ops: readonly Op[], newLeafId: () => string): Snapshot {
	const panes: MutablePane[] = snapshot.panes.map((p) => ({
		id: p.id,
		kind: p.kind,
		leaves: [...p.leaves],
		currentLeafId: p.currentLeafId,
		stacked: p.stacked,
	}));
	let active = snapshot.activeLeafId;
	const holdsActive = (pane: MutablePane): boolean => pane.leaves.some((l) => l.id === active);

	const show = (pane: MutablePane, leafId: string): void => {
		if (active === null || holdsActive(pane)) active = leafId;
		pane.currentLeafId = leafId;
	};

	for (const op of ops) {
		switch (op.kind) {
			case 'move': {
				const { pane, index } = locate(panes, op.leafId);
				if (pane.id !== op.paneId) throw new OpError(`move of ${op.leafId} to another strip`);
				const leaf = at(pane.leaves.splice(index, 1), 0);
				checkIndex(op.index, pane.leaves.length);
				pane.leaves.splice(op.index, 0, leaf);
				break;
			}
			case 'activate': {
				const { pane } = locate(panes, op.leafId);
				show(pane, op.leafId);
				break;
			}
			case 'create': {
				const pane = paneById(panes, op.paneId);
				checkIndex(op.index, pane.leaves.length);
				const id = newLeafId();
				pane.leaves.splice(op.index, 0, { id, pinned: false, fingerprint: { viewType: 'empty' } });
				show(pane, id);
				break;
			}
			case 'close': {
				for (const leafId of op.leafIds) {
					const { pane, index } = locate(panes, leafId);
					pane.leaves.splice(index, 1);
					if (pane.currentLeafId === leafId) {
						pane.currentLeafId = (pane.leaves[index] ?? pane.leaves[index - 1])?.id ?? null;
					}
					if (pane.leaves.length === 0) {
						const otherMain = panes.some((p) => p !== pane && p.kind === 'main');
						if (pane.kind === 'popout' || otherMain) {
							panes.splice(panes.indexOf(pane), 1);
						} else {
							const id = newLeafId();
							pane.leaves.push({ id, pinned: false, fingerprint: { viewType: 'empty' } });
							pane.currentLeafId = id;
						}
					}
					if (active === leafId) {
						const stillThere = panes.includes(pane) ? pane : panes[0];
						active = stillThere?.currentLeafId ?? null;
					}
				}
				break;
			}
		}
	}

	return {
		panes: panes.map((p) => {
			const base = { id: p.id, kind: p.kind, leaves: p.leaves, currentLeafId: p.currentLeafId };
			return p.stacked === undefined ? base : { ...base, stacked: p.stacked };
		}),
		activeLeafId: active,
	};
}
