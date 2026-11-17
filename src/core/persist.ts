/**
 * The per-device session record (persistence tier T1, requirements 7.3): what is written to the
 * app's local storage, how it is built from the live model, and how a stored value is read back.
 *
 * Reading never throws. Anything that is not exactly the expected shape is validated entry by
 * entry: bad entries are skipped (and reported), huge lists are cut, a value written by a newer
 * format version is left alone. Pure: no `obsidian`, no page, no clock.
 */
import { clipName, compareIds, GROUP_NAME_LIMIT, isGroupColor, TOMBSTONE_LIMIT } from './model';
import type { Fingerprint, GroupColor, GroupState, Snapshot, Tombstone } from './types';

/** Format version written by this plugin version. Bump it together with a migration. */
export const SESSION_VERSION = 1;

/** Upper bounds when reading (a stored value may be damaged or written by something else). */
export const SESSION_LIMITS = {
	groups: 200,
	membersPerGroup: 500,
	/** Recently closed records. The ring keeps 25, but one closed pop-out may add many more at once. */
	closed: 200,
	/**
	 * Unmatched groups. At least `groups`, so one restart can park every stored group; when older
	 * entries must go to make room, restore reports how many (never silent, review round 5).
	 */
	unmatched: 200,
	/** Longest kept id or view type. */
	text: 1000,
	/** Longest kept group name (longer ones are cut, not dropped). */
	name: GROUP_NAME_LIMIT,
	/** Longest kept file path. A longer path is not stored: the tab keeps its view type only. */
	path: 4096,
} as const;

/** A tab's file fingerprint as stored. */
export interface StoredFingerprint {
	readonly type: string;
	readonly path?: string;
}

export interface StoredMember extends StoredFingerprint {
	readonly leafId: string;
}

export interface StoredGroup {
	readonly groupId: string;
	readonly name: string;
	readonly color: GroupColor;
	readonly collapsed: boolean;
	/** Members in tab order. */
	readonly members: readonly StoredMember[];
}

/** One recently closed group member (a tombstone). */
export interface StoredClosed extends StoredFingerprint {
	readonly leafId: string;
	readonly groupId: string;
	readonly name: string;
	readonly color: GroupColor;
	/** Strip hint: the strip id of the session that wrote it (null once that strip closed). */
	readonly pane: string | null;
	readonly paneIndex: number;
	readonly indexInGroup: number;
	/** Neighbour leaf ids when it closed: find the strip again in a later session. */
	readonly left: string | null;
	readonly right: string | null;
}

/** A group none of whose tabs could be found at start-up. "Restore unmatched groups" tries again. */
export interface UnmatchedGroup {
	readonly groupId: string;
	readonly name: string;
	readonly color: GroupColor;
	readonly collapsed: boolean;
	readonly members: readonly StoredFingerprint[];
}

/**
 * Tab strip orientation on this device (step V1). Stored in the session record as an optional field,
 * written only for 'vertical': a horizontal record stays exactly what v0.1 wrote, and v0.1 (which
 * reads only the fields it knows) ignores the field, so a downgrade simply falls back to horizontal.
 */
export type Orientation = 'horizontal' | 'vertical';

/** Width limits and default of the expanded vertical strip, in CSS px (step V3). */
export const STRIP_WIDTH = { min: 180, max: 480, default: 240 } as const;

/**
 * Per-device look of the vertical strip (step V3): its expanded width and whether it is collapsed to
 * the icon bar. Optional fields of the session record, written only when they differ from the
 * defaults, so a record without them is exactly what V1 wrote.
 */
export interface StripPrefs {
	/** Whole CSS px within STRIP_WIDTH; absent means the default. */
	readonly width?: number;
	/** Present (true) only when collapsed to the icon bar. */
	readonly collapsed?: true;
}

/** Clamps a width into STRIP_WIDTH (whole px); a value that is not a finite number gives the default. */
export function clampStripWidth(width: number): number {
	if (!Number.isFinite(width)) return STRIP_WIDTH.default;
	return Math.round(Math.min(STRIP_WIDTH.max, Math.max(STRIP_WIDTH.min, width)));
}

/** The prefs as stored: default values left out; undefined when nothing differs from the defaults. */
export function storedStripPrefs(prefs: StripPrefs): StripPrefs | undefined {
	const width = prefs.width === undefined ? undefined : clampStripWidth(prefs.width);
	const out: { width?: number; collapsed?: true } = {};
	if (width !== undefined && width !== STRIP_WIDTH.default) out.width = width;
	if (prefs.collapsed === true) out.collapsed = true;
	return out.width === undefined && out.collapsed === undefined ? undefined : out;
}

/** Strip prefs from a stored value; anything unexpected is left out (defaults), without a problem report. */
function readStripPrefs(value: unknown): StripPrefs | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const width = raw['width'];
	return storedStripPrefs({
		...(typeof width === 'number' && Number.isInteger(width) && width >= STRIP_WIDTH.min && width <= STRIP_WIDTH.max ? { width } : {}),
		...(raw['collapsed'] === true ? { collapsed: true as const } : {}),
	});
}

export interface Session {
	readonly version: typeof SESSION_VERSION;
	/** Only present when vertical (see Orientation). */
	readonly orientation?: 'vertical';
	/** Step V3: vertical strip width and icon bar state, only when not the defaults. */
	readonly vstrip?: StripPrefs;
	readonly nextGroupSeq: number;
	readonly groups: readonly StoredGroup[];
	/** Newest first. */
	readonly closed: readonly StoredClosed[];
	/** Newest first. */
	readonly unmatched: readonly UnmatchedGroup[];
}

export type ParseResult =
	/** Nothing stored. */
	| { readonly kind: 'empty' }
	/** Usable. `problems` lists what was skipped or repaired (empty when the value was clean). */
	| { readonly kind: 'ok'; readonly session: Session; readonly problems: readonly string[] }
	/** Written by a newer plugin version: keep it untouched, start empty. */
	| { readonly kind: 'future'; readonly version: number }
	/** Not a session at all (wrong type, no or bad version, failed migration). */
	| { readonly kind: 'corrupt'; readonly problems: readonly string[] };

type Raw = Record<string, unknown>;

/**
 * Migration hook: `MIGRATIONS[n]` turns a version n value into a version n + 1 value. Version 1 is
 * the first format, so there is none yet; a stored version below 1 without a migration is corrupt.
 */
export const MIGRATIONS: Readonly<Record<number, (value: Raw) => Raw>> = {};

function isRaw(value: unknown): value is Raw {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.length <= SESSION_LIMITS.text ? value : null;
}

function nonEmptyText(value: unknown): string | null {
	const t = text(value);
	return t !== null && t.length > 0 ? t : null;
}

/** A stored group name: cut to the limit (reported), '' when not a string. */
function nameOf(value: unknown, where: string, problems: string[]): string {
	if (typeof value !== 'string') return '';
	if (value.length > SESSION_LIMITS.name) problems.push(`${where}: name cut`);
	return clipName(value);
}

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

/** First `limit` entries of an array (others reported), or null when it is not an array. */
function list(value: unknown, limit: number, what: string, problems: string[]): readonly unknown[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length > limit) problems.push(`${what}: kept the first ${String(limit)} of ${String(value.length)}`);
	return (value as readonly unknown[]).slice(0, limit);
}

function fingerprintOf(raw: Raw): StoredFingerprint | null {
	const type = nonEmptyText(raw['type']);
	if (type === null) return null;
	const path = raw['path'];
	if (path === undefined) return { type };
	// An empty path is valid (a view whose state has `file: ''`); the writer never stores a longer one.
	return typeof path === 'string' && path.length <= SESSION_LIMITS.path ? { type, path } : null;
}

/** Keeps a Chrome colour; anything else becomes grey (reported). */
function colorOf(value: unknown, where: string, problems: string[]): GroupColor {
	if (typeof value === 'string' && isGroupColor(value)) return value;
	problems.push(`${where}: unknown colour, using grey`);
	return 'grey';
}

function readGroups(value: unknown, problems: string[], seenLeaves: Set<string>, seenGroups: Set<string>): StoredGroup[] {
	const raw = list(value, SESSION_LIMITS.groups, 'groups', problems);
	if (raw === null) {
		if (value !== undefined) problems.push('groups: not a list');
		return [];
	}
	const out: StoredGroup[] = [];
	raw.forEach((entry, i) => {
		const where = `groups[${String(i)}]`;
		if (!isRaw(entry)) return void problems.push(`${where}: not an object`);
		const id = nonEmptyText(entry['groupId']);
		if (id === null || seenGroups.has(id)) return void problems.push(`${where}: missing or duplicate id`);
		const members: StoredMember[] = [];
		const rawMembers = list(entry['members'], SESSION_LIMITS.membersPerGroup, `${where}.members`, problems) ?? [];
		rawMembers.forEach((m, k) => {
			const fp = isRaw(m) ? fingerprintOf(m) : null;
			const leafId = isRaw(m) ? nonEmptyText(m['leafId']) : null;
			if (fp === null || leafId === null || seenLeaves.has(leafId)) {
				problems.push(`${where}.members[${String(k)}]: skipped`);
				return;
			}
			seenLeaves.add(leafId);
			members.push({ leafId, ...fp });
		});
		if (members.length === 0) return void problems.push(`${where}: no usable member`);
		seenGroups.add(id);
		out.push({
			groupId: id,
			name: nameOf(entry['name'], where, problems),
			color: colorOf(entry['color'], where, problems),
			collapsed: entry['collapsed'] === true,
			members,
		});
	});
	return out;
}

function readClosed(value: unknown, problems: string[]): StoredClosed[] {
	const raw = list(value, SESSION_LIMITS.closed, 'closed', problems);
	if (raw === null) {
		if (value !== undefined) problems.push('closed: not a list');
		return [];
	}
	const out: StoredClosed[] = [];
	const seen = new Set<string>();
	raw.forEach((entry, i) => {
		const where = `closed[${String(i)}]`;
		const fp = isRaw(entry) ? fingerprintOf(entry) : null;
		if (!isRaw(entry) || fp === null) return void problems.push(`${where}: skipped`);
		const id = nonEmptyText(entry['leafId']);
		const group = nonEmptyText(entry['groupId']);
		const paneIndex = count(entry['paneIndex']);
		const indexInGroup = count(entry['indexInGroup']);
		if (id === null || group === null || paneIndex === null || indexInGroup === null || seen.has(id)) {
			return void problems.push(`${where}: skipped`);
		}
		seen.add(id);
		const optionalId = (v: unknown): string | null => nonEmptyText(v);
		out.push({
			leafId: id,
			groupId: group,
			name: nameOf(entry['name'], where, problems),
			color: colorOf(entry['color'], where, problems),
			pane: optionalId(entry['pane']),
			paneIndex,
			indexInGroup,
			left: optionalId(entry['left']),
			right: optionalId(entry['right']),
			...fp,
		});
	});
	return out;
}

function readUnmatched(value: unknown, problems: string[], seenGroups: Set<string>): UnmatchedGroup[] {
	const raw = list(value, SESSION_LIMITS.unmatched, 'unmatched', problems);
	if (raw === null) {
		if (value !== undefined) problems.push('unmatched: not a list');
		return [];
	}
	const out: UnmatchedGroup[] = [];
	raw.forEach((entry, i) => {
		const where = `unmatched[${String(i)}]`;
		if (!isRaw(entry)) return void problems.push(`${where}: not an object`);
		const id = nonEmptyText(entry['groupId']);
		if (id === null || seenGroups.has(id)) return void problems.push(`${where}: missing or duplicate id`);
		const members: StoredFingerprint[] = [];
		for (const m of list(entry['members'], SESSION_LIMITS.membersPerGroup, `${where}.members`, problems) ?? []) {
			const fp = isRaw(m) ? fingerprintOf(m) : null;
			if (fp === null) problems.push(`${where}: member skipped`);
			else members.push(fp);
		}
		if (members.length === 0) return void problems.push(`${where}: no usable member`);
		seenGroups.add(id);
		out.push({
			groupId: id,
			name: nameOf(entry['name'], where, problems),
			color: colorOf(entry['color'], where, problems),
			collapsed: entry['collapsed'] === true,
			members,
		});
	});
	return out;
}

/** Largest numeric part of a generated group id that `seqOf` reads (`g` and up to 9 digits). */
const MAX_SEQ = 999_999_999;

/** Numeric part of a generated group id (`g12` → 12), or 0. */
function seqOf(groupId: string): number {
	const m = /^g(\d{1,9})$/.exec(groupId);
	return m === null ? 0 : Number(m[1]);
}

/**
 * A stored group counter: an integer from 1 to one past the largest id `seqOf` reads, so a counter
 * derived from any readable id is read back as it was written (review round 2).
 */
function groupSeq(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_SEQ + 1 ? value : null;
}

/**
 * Reads a stored value (as returned by the app's local storage: already JSON-parsed, possibly
 * anything). Never throws. `migrations` is for tests; the plugin uses `MIGRATIONS`.
 */
export function parseSession(stored: unknown, migrations: Readonly<Record<number, (value: Raw) => Raw>> = MIGRATIONS): ParseResult {
	if (stored === null || stored === undefined) return { kind: 'empty' };
	if (!isRaw(stored)) return { kind: 'corrupt', problems: ['not an object'] };
	const version = stored['version'];
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
		return { kind: 'corrupt', problems: ['no format version'] };
	}
	if (version > SESSION_VERSION) return { kind: 'future', version };
	let value: Raw = stored;
	for (let v = version; v < SESSION_VERSION; v++) {
		const migrate = migrations[v];
		if (migrate === undefined) return { kind: 'corrupt', problems: [`no migration from version ${String(v)}`] };
		try {
			value = migrate(value);
		} catch {
			return { kind: 'corrupt', problems: [`migration from version ${String(v)} failed`] };
		}
	}
	const problems: string[] = [];
	const seenLeaves = new Set<string>();
	const seenGroups = new Set<string>();
	const groups = readGroups(value['groups'], problems, seenLeaves, seenGroups);
	const closed = readClosed(value['closed'], problems);
	const unmatched = readUnmatched(value['unmatched'], problems, seenGroups);
	let highest = 0;
	for (const id of [...seenGroups, ...closed.map((c) => c.groupId)]) highest = Math.max(highest, seqOf(id));
	const storedSeq = groupSeq(value['nextGroupSeq']);
	if (storedSeq === null) problems.push('nextGroupSeq: missing, derived from the group ids');
	const nextGroupSeq = Math.max(storedSeq ?? 1, highest + 1, 1);
	// Any other value (a later version's orientation name) means horizontal, without a problem report.
	const vertical = value['orientation'] === 'vertical';
	const vstrip = readStripPrefs(value['vstrip']);
	return {
		kind: 'ok',
		session: { version: SESSION_VERSION, ...(vertical ? { orientation: 'vertical' as const } : {}), ...(vstrip !== undefined ? { vstrip } : {}), nextGroupSeq, groups, closed, unmatched },
		problems,
	};
}

/** True when the reader keeps this id or view type (`nonEmptyText`). */
function storable(value: string): boolean {
	return value.length > 0 && value.length <= SESSION_LIMITS.text;
}

function storableOrNull(value: string | null | undefined): string | null {
	return value !== null && value !== undefined && storable(value) ? value : null;
}

/**
 * The writer stores only what the reader accepts, so a saved session reads back without
 * problems: a path over the limit is left out (the tab keeps its view type).
 */
function storedFingerprint(fp: Fingerprint): StoredFingerprint {
	return fp.path === undefined || fp.path.length > SESSION_LIMITS.path ? { type: fp.viewType } : { type: fp.viewType, path: fp.path };
}

export function fingerprintFromStored(fp: StoredFingerprint): Fingerprint {
	return fp.path === undefined ? { viewType: fp.type } : { viewType: fp.type, path: fp.path };
}

function closedFromTombstone(t: Tombstone): StoredClosed {
	return {
		leafId: t.leafId,
		groupId: t.groupId,
		name: clipName(t.groupName),
		color: t.groupColor,
		pane: storableOrNull(t.paneId),
		paneIndex: t.paneIndex,
		indexInGroup: t.indexInGroup,
		left: storableOrNull(t.left),
		right: storableOrNull(t.right),
		...storedFingerprint(t.fingerprint),
	};
}

export function tombstoneFromClosed(c: StoredClosed): Tombstone {
	return {
		leafId: c.leafId,
		groupId: c.groupId,
		groupName: c.name,
		groupColor: c.color,
		paneId: c.pane,
		paneIndex: c.paneIndex,
		indexInGroup: c.indexInGroup,
		fingerprint: fingerprintFromStored(c),
		left: c.left,
		right: c.right,
	};
}

/**
 * The record to store for this model state. Members are listed in tab order (strips in snapshot
 * order); members not in the snapshot keep the end, sorted by id.
 */
export function buildSession(state: GroupState, snapshot: Snapshot, unmatched: readonly UnmatchedGroup[], orientation: Orientation = 'horizontal', prefs: StripPrefs = {}): Session {
	const vstrip = storedStripPrefs(prefs);
	const position = new Map<string, number>();
	let n = 0;
	for (const pane of snapshot.panes) for (const leaf of pane.leaves) if (!position.has(leaf.id)) position.set(leaf.id, n++);
	const byGroup = new Map<string, StoredMember[]>();
	const members = [...state.members].sort((a, b) => {
		const pa = position.get(a.leafId) ?? Number.MAX_SAFE_INTEGER;
		const pb = position.get(b.leafId) ?? Number.MAX_SAFE_INTEGER;
		return pa !== pb ? pa - pb : compareIds(a.leafId, b.leafId);
	});
	for (const m of members) {
		// Leaf ids and view types from Obsidian are short; one the reader would drop is not written.
		if (!storable(m.leafId) || !storable(m.fingerprint.viewType)) continue;
		const listed = byGroup.get(m.groupId) ?? [];
		listed.push({ leafId: m.leafId, ...storedFingerprint(m.fingerprint) });
		byGroup.set(m.groupId, listed);
	}
	const groups: StoredGroup[] = [];
	for (const g of state.groups) {
		const listed = byGroup.get(g.id);
		if (listed !== undefined && storable(g.id)) groups.push({ groupId: g.id, name: clipName(g.name), color: g.color, collapsed: g.collapsed, members: listed });
	}
	const closed: StoredClosed[] = [];
	const closedIds = new Set<string>();
	for (const t of state.tombstones) {
		if (closed.length >= Math.min(Math.max(TOMBSTONE_LIMIT, state.tombstones.length), SESSION_LIMITS.closed)) break;
		// The reader keeps the first record per leaf (newest first) and needs storable ids.
		if (closedIds.has(t.leafId) || !storable(t.leafId) || !storable(t.groupId) || !storable(t.fingerprint.viewType)) continue;
		closedIds.add(t.leafId);
		closed.push(closedFromTombstone(t));
	}
	return {
		version: SESSION_VERSION,
		...(orientation === 'vertical' ? { orientation: 'vertical' as const } : {}),
		...(vstrip !== undefined ? { vstrip } : {}),
		nextGroupSeq: state.nextGroupSeq,
		groups,
		closed,
		unmatched: unmatched.slice(0, SESSION_LIMITS.unmatched),
	};
}

/** The orientation a parsed record asks for: vertical only from a readable record that says so. */
/**
 * Review round 2 of V1: group colours of the stored session by leaf id, for the vertical strip's
 * rows drawn before the layout is ready (restore runs only then). Members whose leaf id comes back
 * get their colour bar at once; the rest follow when restore has run.
 */
export function storedColors(parsed: ParseResult): { groups: { id: string; color: GroupColor; name: string; collapsed: boolean }[]; members: { leafId: string; groupId: string }[] } {
	if (parsed.kind !== 'ok') return { groups: [], members: [] };
	const groups = parsed.session.groups.map((g) => ({ id: g.groupId, color: g.color, name: g.name, collapsed: g.collapsed }));
	const members = parsed.session.groups.flatMap((g) => g.members.map((m) => ({ leafId: m.leafId, groupId: g.groupId })));
	return { groups, members };
}

/** Step V3: the strip prefs a parsed record holds (defaults when none or unreadable). */
export function stripPrefsOf(parsed: ParseResult): StripPrefs {
	return parsed.kind === 'ok' ? (parsed.session.vstrip ?? {}) : {};
}

export function orientationOf(parsed: ParseResult): Orientation {
	return parsed.kind === 'ok' && parsed.session.orientation === 'vertical' ? 'vertical' : 'horizontal';
}
