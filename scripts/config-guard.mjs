/**
 * Interlock for `scripts/e2e.mjs --config <file>`.
 *
 * The sandbox interlocks (throwaway HOME, patched installer without bundle id) run when the root
 * ./wdio.conf.mts is evaluated, so any other wdio config has to import it and build on its `config`.
 * A text search is not enough (a commented-out import, an import inside a string, or an import of
 * some other file that is also called wdio.conf.mts would pass it), so the config is parsed with the
 * TypeScript parser and its real import declarations are resolved against the file system.
 *
 * Accepted: the root config itself; or a config inside the repo with a top-level, value (not
 * type-only) import declaration whose specifier resolves exactly to <repo>/wdio.conf.mts and that
 * binds the root `config` (`import { config } ...`, `import { config as base } ...` or
 * `import * as root ...`) and uses that binding as a value.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const ROOT_CONFIG_NAME = 'wdio.conf.mts';

const realpathOrNull = (p) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
};

/** Local names under which an import clause brings the root `config` into scope as a value. */
function configBindings(clause) {
	if (!clause || clause.isTypeOnly) return [];
	const bindings = clause.namedBindings;
	if (!bindings) return [];
	if (ts.isNamespaceImport(bindings)) return [bindings.name.text];
	return bindings.elements.filter((el) => !el.isTypeOnly && (el.propertyName ?? el.name).text === 'config').map((el) => el.name.text);
}

/** True when `name` is used as a value somewhere outside import declarations and type positions. */
function usedAsValue(source, name) {
	let used = false;
	const visit = (node) => {
		if (used || ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
		if (ts.isIdentifier(node) && node.text === name) {
			const parent = node.parent;
			// `x.name` and `{ name: ... }` are other things called `name`, not the binding.
			const isMemberName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
			const isKey = parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
			if (!isMemberName && !isKey) used = true;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return used;
}

/**
 * Resolves the base-config imports of a wdio config.
 * Returns [{ specifier, resolved, bindsConfig, typeOnly }] for every top-level import declaration
 * whose specifier is a relative or absolute path. `bindsConfig` is true when the declaration binds
 * the root `config` as a value AND that binding is used as a value: TypeScript loaders drop value
 * imports that are never used, and then the root config would not be evaluated at all.
 */
export function pathImports(configFile) {
	const text = fs.readFileSync(configFile, 'utf8');
	const source = ts.createSourceFile(configFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const out = [];
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		const specifier = statement.moduleSpecifier.text;
		if (!specifier.startsWith('./') && !specifier.startsWith('../') && !path.isAbsolute(specifier)) continue;
		const resolved = path.resolve(path.dirname(configFile), specifier);
		out.push({
			specifier,
			resolved: realpathOrNull(resolved) ?? resolved,
			bindsConfig: configBindings(statement.importClause).some((name) => usedAsValue(source, name)),
			typeOnly: Boolean(statement.importClause?.isTypeOnly),
		});
	}
	return out;
}

/**
 * Checks the --config argument. Returns { ok, configPath, isRoot, problems }.
 * `configArg` is resolved against `repoRoot` (like the command line does).
 */
export function checkWdioConfig(configArg, repoRoot) {
	const problems = [];
	const realRoot = realpathOrNull(repoRoot) ?? path.resolve(repoRoot);
	const rootConfig = path.join(realRoot, ROOT_CONFIG_NAME);
	if (!configArg) return { ok: false, configPath: '', isRoot: false, problems: ['no config given'] };
	const configPath = path.resolve(repoRoot, configArg);
	const real = realpathOrNull(configPath);
	if (!real || !fs.statSync(real).isFile()) {
		problems.push(`${configArg} is not an existing file`);
		return { ok: false, configPath, isRoot: false, problems };
	}
	if (!real.startsWith(realRoot + path.sep)) {
		problems.push(`${configArg} resolves to ${real}, outside the repo ${realRoot}`);
		return { ok: false, configPath, isRoot: false, problems };
	}
	if (real === rootConfig) return { ok: true, configPath: real, isRoot: true, problems };

	const imports = pathImports(real);
	const good = imports.filter((i) => i.resolved === rootConfig && i.bindsConfig);
	if (good.length === 0) {
		const seen = imports.map((i) => `${i.specifier} -> ${i.resolved}${i.typeOnly ? ' (type-only)' : i.bindsConfig ? '' : ' (no config binding)'}`);
		problems.push(
			`${configArg} has no import declaration of the root config ${rootConfig} that binds its \`config\` (path imports found: ${seen.length ? seen.join('; ') : 'none'})`,
		);
	}
	return { ok: problems.length === 0, configPath: real, isRoot: false, problems };
}
