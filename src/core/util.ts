/**
 * Checked access helpers. A miss is a bug in the model, so it throws instead of
 * silently falling back to a default value.
 */

export function at<T>(list: readonly T[], index: number): T {
	const value = list[index];
	if (value === undefined) throw new RangeError(`tabstrip core: index ${String(index)} out of range`);
	return value;
}

export function get<K, V>(map: ReadonlyMap<K, V>, key: K): V {
	const value = map.get(key);
	if (value === undefined) throw new RangeError(`tabstrip core: missing key ${String(key)}`);
	return value;
}

/** Typed-array read; callers only pass in-range indexes. */
export function slot(array: Int32Array | Float64Array, index: number): number {
	return array[index] as number;
}
