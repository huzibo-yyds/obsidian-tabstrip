/**
 * Order helpers: which tabs stayed put, and how to reach a target order with few moves.
 */
import type { Op } from './types';
import { at, slot } from './util';

/**
 * Marks a longest strictly increasing subsequence of `keys`.
 *
 * `keys` are distinct integers in [0, keySpace). Among the longest subsequences the one
 * with the highest total `weight` wins; remaining ties go to the one found first.
 * Runs in O(n log n) with a Fenwick tree over the key space.
 */
export function stableSubsequence(
	keys: readonly number[],
	weight: (index: number) => number,
	keySpace: number,
): boolean[] {
	const n = keys.length;
	const keep: boolean[] = new Array<boolean>(n).fill(false);

	const treeLen = new Int32Array(keySpace + 1);
	const treeWeight = new Float64Array(keySpace + 1);
	const treeIdx = new Int32Array(keySpace + 1).fill(-1);
	const before = new Int32Array(n).fill(-1);

	let bestEnd = -1;
	let bestLen = 0;
	let bestWeight = 0;
	for (let j = 0; j < n; j++) {
		const key = at(keys, j);
		// Best chain that ends at a key smaller than `key`.
		let qLen = 0;
		let qWeight = 0;
		let qIdx = -1;
		for (let i = key; i > 0; i -= i & -i) {
			const l = slot(treeLen, i);
			const w = slot(treeWeight, i);
			if (l > qLen || (l === qLen && w > qWeight)) {
				qLen = l;
				qWeight = w;
				qIdx = slot(treeIdx, i);
			}
		}
		const len = qLen + 1;
		const total = qWeight + weight(j);
		before[j] = qIdx;
		for (let i = key + 1; i <= keySpace; i += i & -i) {
			const l = slot(treeLen, i);
			if (len > l || (len === l && total > slot(treeWeight, i))) {
				treeLen[i] = len;
				treeWeight[i] = total;
				treeIdx[i] = j;
			}
		}
		if (len > bestLen || (len === bestLen && total > bestWeight)) {
			bestEnd = j;
			bestLen = len;
			bestWeight = total;
		}
	}
	for (let j = bestEnd; j >= 0; j = slot(before, j)) keep[j] = true;
	return keep;
}

const noWeight = (): number => 0;

/**
 * Plans `move` ops that turn `current` into `target` (same ids, another order) in
 * strip `paneId`. Only tabs outside a longest common subsequence move, so the number
 * of moves is minimal. Applying the ops in order yields `target`.
 */
export function planReorder(paneId: string, current: readonly string[], target: readonly string[]): Op[] {
	const targetIndex = new Map<string, number>();
	target.forEach((id, i) => targetIndex.set(id, i));
	const keys = current.map((id) => targetIndex.get(id) ?? -1);
	if (keys.some((k) => k < 0) || current.length !== target.length) {
		throw new RangeError('tabstrip core: reorder target is not a permutation');
	}
	const stay = stableSubsequence(keys, noWeight, target.length);
	const placed = new Set<string>();
	current.forEach((id, i) => {
		if (at(stay, i)) placed.add(id);
	});

	const order = [...current];
	const ops: Op[] = [];
	target.forEach((id, t) => {
		if (placed.has(id)) return;
		order.splice(order.indexOf(id), 1);
		// Insert right after the previous target id, which is already in place.
		const index = t === 0 ? 0 : order.indexOf(at(target, t - 1)) + 1;
		order.splice(index, 0, id);
		placed.add(id);
		ops.push({ kind: 'move', leafId: id, paneId, index });
	});
	return ops;
}
