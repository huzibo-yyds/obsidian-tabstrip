import { describe, expect, it } from 'vitest';
import { readLeafId, readTabsShape, sameOrder } from '../../src/adapter/shape';

const leaf = (id: unknown) => ({ id, view: {} });

describe('readLeafId', () => {
	it('returns a non-empty string id', () => {
		expect(readLeafId(leaf('a1b2c3'))).toBe('a1b2c3');
	});

	it.each([[null], [undefined], [42], ['a'], [{}], [leaf('')], [leaf(7)]])(
		'returns null for %j',
		(value) => {
			expect(readLeafId(value)).toBeNull();
		},
	);
});

describe('readTabsShape', () => {
	it('reads ids in children order, the current index and the stacked flag', () => {
		const tabs = { children: [leaf('x'), leaf('y'), leaf('z')], currentTab: 1, isStacked: false };
		expect(readTabsShape(tabs)).toEqual({ leafIds: ['x', 'y', 'z'], currentIndex: 1, stacked: false });
	});

	it('treats a missing isStacked as not stacked', () => {
		expect(readTabsShape({ children: [leaf('x')], currentTab: 0 })?.stacked).toBe(false);
	});

	it('reports -1 as the current index of an empty strip', () => {
		expect(readTabsShape({ children: [], currentTab: 0 })).toEqual({
			leafIds: [],
			currentIndex: -1,
			stacked: false,
		});
	});

	it.each([
		['not an object', 'tabs'],
		['children missing', { currentTab: 0 }],
		['children not an array', { children: {}, currentTab: 0 }],
		['a child without id', { children: [leaf('x'), {}], currentTab: 0 }],
		['duplicate ids', { children: [leaf('x'), leaf('x')], currentTab: 0 }],
		['currentTab missing', { children: [leaf('x')] }],
		['currentTab not an integer', { children: [leaf('x')], currentTab: 0.5 }],
		['currentTab out of range', { children: [leaf('x')], currentTab: 1 }],
		['negative currentTab', { children: [leaf('x')], currentTab: -1 }],
		['isStacked not a boolean', { children: [leaf('x')], currentTab: 0, isStacked: 'yes' }],
	])('returns null when %s', (_label, tabs) => {
		expect(readTabsShape(tabs)).toBeNull();
	});
});

describe('sameOrder', () => {
	it('compares ids position by position', () => {
		expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
		expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
		expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
		expect(sameOrder([], [])).toBe(true);
	});
});
