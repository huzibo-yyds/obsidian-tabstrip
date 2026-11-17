import { describe, expect, it } from 'vitest';
import { ACTIVATION_MODES, DEFAULT_ACTIVATION_MODE, sandboxActivationMode } from '../../scripts/sandbox-app.mjs';

// Which Info.plist activation key the patched sandbox copy gets (step Q, quiet sandbox).
describe('sandbox activation mode', () => {
	it('defaults to a background-only sandbox (no Dock icon, never the active app)', () => {
		expect(DEFAULT_ACTIVATION_MODE).toBe('background');
		expect(sandboxActivationMode({})).toBe('background');
		expect(sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: '' })).toBe('background');
		expect(ACTIVATION_MODES.background).toEqual({ LSBackgroundOnly: true });
	});

	it('refuses modes that can take the focus unless the user opts in', () => {
		expect(() => sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: 'regular' })).toThrow(/TABSTRIP_ALLOW_FOREGROUND/);
		expect(() => sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: 'uielement' })).toThrow(/TABSTRIP_ALLOW_FOREGROUND/);
		expect(() =>
			sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: 'regular', TABSTRIP_ALLOW_FOREGROUND: 'yes' }),
		).toThrow(/TABSTRIP_ALLOW_FOREGROUND/);
		expect(sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: 'background' })).toBe('background');
	});

	it('can be switched back to a normal app or to an agent app with the opt-in', () => {
		const allow = { TABSTRIP_ALLOW_FOREGROUND: '1' };
		expect(sandboxActivationMode({ ...allow, TABSTRIP_SANDBOX_ACTIVATION: 'regular' })).toBe('regular');
		expect(ACTIVATION_MODES.regular).toEqual({});
		expect(sandboxActivationMode({ ...allow, TABSTRIP_SANDBOX_ACTIVATION: ' uielement ' })).toBe('uielement');
		expect(ACTIVATION_MODES.uielement).toEqual({ LSUIElement: true });
	});

	it('refuses unknown modes', () => {
		expect(() => sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: 'hidden' })).toThrow(/must be one of/);
		expect(() => sandboxActivationMode({ TABSTRIP_SANDBOX_ACTIVATION: 'toString' })).toThrow(/must be one of/);
	});
});
