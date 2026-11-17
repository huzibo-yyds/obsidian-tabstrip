/**
 * Pure group model (requirements 5.1, 7.1). No `obsidian` import and no page access
 * anywhere in this folder; the lint config and a unit test enforce that.
 */
export * from './types';
export { colorForNewGroup, emptyState, isGroupColor, pickColor, TOMBSTONE_LIMIT } from './model';
export {
	addToGroup,
	closeGroup,
	collapseOthers,
	createGroup,
	recolorGroup,
	removeFromGroup,
	renameGroup,
	setCollapsed,
	ungroup,
	type CreateGroupResult,
} from './commands';
export { reconcile } from './reconcile';
export { isHidden, stepVisible, type Direction } from './navigate';
export { invariants } from './invariants';
export { applyOps, OpError } from './ops';
export {
	buildSession,
	MIGRATIONS,
	clampStripWidth,
	orientationOf,
	storedColors,
	stripPrefsOf,
	STRIP_WIDTH,
	type StripPrefs,
	parseSession,
	SESSION_LIMITS,
	SESSION_VERSION,
	type Orientation,
	type ParseResult,
	type Session,
	type StoredClosed,
	type StoredFingerprint,
	type StoredGroup,
	type StoredMember,
	type UnmatchedGroup,
} from './persist';
export { dropRevived, restoreSession, restoreUnmatched, windowOf, withoutLeaves, type RestoreReport, type RestoreResult, type UnmatchedResult } from './restore';
export {
	DROP_TTL_MS,
	dropAfterCollapsed,
	dropInPlace,
	dropIntentOf,
	dropMoved,
	dropUse,
	landing,
	movedSnapshot,
	predictDrop,
	spotAt,
	stepTarget,
	type ChipBox,
	type DropPrediction,
	type DropSpot,
	type DropTarget,
	type HeaderBox,
} from './drag';
