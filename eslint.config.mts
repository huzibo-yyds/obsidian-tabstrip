import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { globalIgnores, defineConfig } from 'eslint/config';

// Based on the official obsidian-sample-plugin config. `obsidianmd.configs.recommended`
// already includes typescript-eslint's recommended (type-checked for TS) rules.
// The plugin source (src/) additionally gets typescript-eslint's strict type-checked set.

// Project hard rules for the plugin source (no-restricted-syntax selectors): no innerHTML,
// no prototype patching, no network calls.
const srcRestrictedSyntax = [
	{
		selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]',
		message: 'Build DOM with createEl/setText instead of HTML strings.',
	},
	// No prototype patching. Any `.prototype` access is an error (this also covers casts,
	// aliases, Object.assign/defineProperty on a prototype), and so are the other ways to
	// reach or replace a prototype or redefine members of an existing object.
	{
		selector: "MemberExpression[property.name='prototype'], MemberExpression[computed=true][property.value='prototype']",
		message: 'Do not touch prototypes (no prototype patching).',
	},
	{
		selector:
			"MemberExpression[property.name='__proto__'], MemberExpression[computed=true][property.value='__proto__'], Property[key.name='__proto__']",
		message: 'Do not touch prototypes (no prototype patching).',
	},
	{
		selector:
			'CallExpression[callee.object.name=/^(Object|Reflect)$/][callee.property.name=/^(defineProperty|defineProperties|setPrototypeOf|getPrototypeOf)$/]',
		message: 'Do not patch objects or prototypes.',
	},
	{
		selector: "CallExpression[callee.object.name='Object'][callee.property.name='assign'][arguments.0.type!='ObjectExpression']",
		message: 'Object.assign may only fill a fresh object literal ({}); do not patch existing objects.',
	},
	{
		selector: "ImportDeclaration[source.value='monkey-around']",
		message: 'Do not patch prototypes.',
	},
	// No network calls: fetch in any form (fetch, window.fetch, activeWindow.fetch,
	// globalThis.fetch), Obsidian's request helpers, XHR/WebSocket/EventSource/beacons, and
	// Node or Electron networking modules.
	{
		selector: 'ImportSpecifier[imported.name=/^(request|requestUrl)$/]',
		message: 'Tabstrip makes no network calls.',
	},
	{
		selector:
			"CallExpression[callee.name='fetch'], MemberExpression[property.name=/^(fetch|requestUrl|sendBeacon)$/], NewExpression[callee.name=/^(XMLHttpRequest|WebSocket|EventSource)$/], MemberExpression[property.name=/^(XMLHttpRequest|WebSocket|EventSource)$/]",
		message: 'Tabstrip makes no network calls.',
	},
	{
		selector: "MemberExpression[object.name=/^(obsidian|net|electron)$/][property.name='request']",
		message: 'Tabstrip makes no network calls.',
	},
	{
		selector:
			"ImportDeclaration[source.value=/^(node:)?(http|https|http2|net|tls|dgram|electron)$/], CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(http|https|http2|net|tls|dgram|electron)$/]",
		message: 'Tabstrip makes no network calls.',
	},
];

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'main.js',
		'spikes/*/plugin/main.js',
		// Development-only seed plugin for `npm run try -- --vertical` (plain CommonJS, like the e2e probe).
		'scripts/try-seed/main.js',
		'package.json',
		'package-lock.json',
		'versions.json',
		'tsconfig.json',
		'test/e2e/tsconfig.json',
		'test/vaults',
		'docs',
		'.e2e-state',
		'.obsidian-cache',
		// Git-ignored private test material (investigation wrappers); never committed.
		'test/private',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'vitest.config.mts',
						'wdio.conf.mts',
						'esbuild.config.mjs',
						'version-bump.mjs',
						'manifest.json',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: ['src/**/*.ts'] })),
	// Project hard rules for the plugin source: no innerHTML, no default hotkeys,
	// no prototype patching, no network calls.
	{
		files: ['src/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/consistent-type-imports': 'error',
			'@microsoft/sdl/no-inner-html': 'error',
			'obsidianmd/commands/no-default-hotkeys': 'error',
			'no-restricted-syntax': ['error', ...srcRestrictedSyntax],
		},
	},
	// Obsidian's private workspace members (requirements 7.4 whitelist) are reached only through
	// src/adapter; everywhere else in src/ they are an error.
	{
		files: ['src/**/*.ts'],
		ignores: ['src/adapter/**'],
		rules: {
			'no-restricted-syntax': [
				'error',
				...srcRestrictedSyntax,
				{
					selector:
						'MemberExpression[property.name=/^(tabHeaderEl|tabHeaderContainerEl|currentTab|isStacked|insertChild|selectTabIndex|setDimension|requestResize|onDragLeaf|rootSplit|floatingSplit|activeLeaf)$/]',
					message: 'Private workspace members are only used in src/adapter (requirements 7.4).',
				},
				// `leaf.id` is too common a name to ban outright, so catch the ways code reaches it on an
				// Obsidian object: a cast to an inline type that declares it, or a computed read (`leaf['id']`).
				{
					selector:
						"TSAsExpression > TSTypeLiteral > TSPropertySignature[key.name=/^(id|tabHeaderEl|tabHeaderContainerEl|currentTab|isStacked|insertChild|selectTabIndex|setDimension|requestResize|onDragLeaf|rootSplit|floatingSplit|activeLeaf)$/], MemberExpression[computed=true][property.value=/^(id|tabHeaderEl|tabHeaderContainerEl|currentTab|isStacked|insertChild|selectTabIndex|setDimension|requestResize|onDragLeaf|rootSplit|floatingSplit|activeLeaf)$/]",
					message: 'Private workspace members (also leaf.id) are only read in src/adapter (requirements 7.4).',
				},
			],
		},
	},
	// The group model in src/core is pure: no Obsidian API, no page or window access,
	// no timers, and no imports from outside the folder (requirements 7.1).
	{
		files: ['src/core/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [{ name: 'obsidian', message: 'src/core must not depend on Obsidian.' }],
					patterns: [
						{ group: ['obsidian/*', '@codemirror/*', 'electron'], message: 'src/core must not depend on Obsidian.' },
						{ group: ['../*', '../**'], message: 'src/core may only import from src/core.' },
					],
				},
			],
			'no-restricted-globals': [
				'error',
				...[
					'window',
					'document',
					'activeWindow',
					'activeDocument',
					'navigator',
					'localStorage',
					'sessionStorage',
					'HTMLElement',
					'Element',
					'Node',
					'MutationObserver',
					'requestAnimationFrame',
					'setTimeout',
					'setInterval',
					'createEl',
					'createDiv',
					'createSpan',
					'createFragment',
					'app',
				].map((name) => ({ name, message: 'src/core is pure: no page, window or timer access.' })),
			],
		},
	},
	{
		files: ['scripts/**/*.mjs', 'esbuild.config.mjs', 'version-bump.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	{
		files: ['test/e2e/**/*.ts', 'wdio.conf.mts'],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.mocha,
			},
		},
	},
);
