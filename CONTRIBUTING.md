# Contributing to Tabstrip

Thanks for helping. Bug reports are most useful with your Obsidian version, operating system, theme, other tab plugins you use, and the steps that show the problem (the issue template asks for these).

Ground rules for code:

- Plain TypeScript (strict), DOM and the Obsidian API. No runtime dependencies, no network calls, no default hotkeys.
- No prototype patching. Obsidian's internal workspace members are used only through `src/adapter`, behind a start-up capability probe, and only from a short list (tab headers, the tab containers' children and current tab, the native tab move, `workspace.onDragLeaf`, the tab and tab group menus).
- No `innerHTML` / `outerHTML` / `insertAdjacentHTML`; no literal `el.style` writes (use classes or CSS variables through `setCssProps`).
- Never copy code from other plugins or from Obsidian itself. Reading other open-source plugins for ideas is fine; the code here is written from scratch.

## Build and test

Requires Node 22 and npm.

```bash
npm install
npm run build         # typecheck + production build (main.js)
npm run dev           # watch build
npm run check         # build, lint, unit tests
npm run test:coverage # unit tests with coverage of the group model (src/core, at least 90 %)
npm run e2e           # end-to-end tests in a sandboxed Obsidian 1.15.0 (macOS)
npm run e2e:matrix    # the same on Obsidian 1.13.4, 1.14.4 and 1.15.0
npm run try           # open the plugin in a throwaway sandbox Obsidian to try it by hand
```

## Code layout

The code has three layers:

- `src/core`: the pure group model. Plain TypeScript with no Obsidian import and no page access (enforced by lint and a unit test), covered by example and property-based tests (fast-check). Set `FC_RUNS` to run the properties more often, for example `FC_RUNS=20000 npm test`.
- `src/adapter`: the only place that touches Obsidian's private workspace members, behind a start-up capability probe. When a member is missing, only the features that need it are turned off.
- `src/ui`: tab header decoration, menus, the editor bubble and the vertical strip.

`src/controller.ts` wires them to workspace events and `src/main.ts` registers the commands. Every user-visible string is in `src/i18n.ts`, in English and Simplified Chinese.

## End-to-end tests and the sandbox

`npm run e2e` downloads Obsidian into `~/.obsidian-cache` on first run and starts a separate, sandboxed Obsidian (macOS only for now): its own config directory, its own `HOME`, and a patched, ad-hoc signed copy of the installer without a bundle id, so it cannot write the host app's macOS preferences (`md.obsidian`) or become the `obsidian://` handler (`scripts/sandbox-app.mjs`). It checks before, during and after the run that the Obsidian you have open was not touched (`scripts/check-host.mjs`; `npm run guard:self-test` tests the checks themselves). Only one sandbox runs at a time (`scripts/sandbox-lock.mjs`).

The sandbox runs quietly, so you can keep working while the tests run: the patched copy is a background-only app (`LSBackgroundOnly`), so it has no Dock icon and never becomes the frontmost app or takes the keyboard focus. Its windows are invisible and let clicks through (`test/e2e/invisible.ts`). Each run ends with a line such as `focus taken by sandbox: 0 times` from a focus monitor (`scripts/focus-monitor.mjs`, report only). To watch a run as a normal app (Dock icon, focused window), use `TABSTRIP_SANDBOX_ACTIVATION=regular npm run e2e`.

The sandbox always renders at a device scale factor of 2 (Chromium's `--force-device-scale-factor=2`), so the pixel checks work the same on a Retina screen and on a 1x monitor; your display settings are not touched (`test/e2e/specs/scale.e2e.ts` checks it; `TABSTRIP_SANDBOX_SCALE=1` exists only for its control run).

Notes on the specs:

- `npm run e2e -- --spec test/e2e/specs/l4-groups.e2e.ts` runs one spec file. Iterate with a single spec on 1.15.0 and run the matrix once at the end.
- The drag cases start each drag with real pointer input on the tab, with Chromium's drag interception on (DevTools `Input.setInterceptDrags`), so a drag never becomes a system drag that could reach another app; moves and drops are browser-level drag events (`Input.dispatchDragEvent`), see `test/e2e/drag.ts`. With `TABSTRIP_WRITE_FIXTURES=1` the 1.15.0 run rewrites the recorded event sequences in `test/unit/core/fixtures/s5/`.
- The restart cases (`l6-persist`) quit and start the sandbox app with `browser.reloadObsidian()`.
- Screenshots go to `.e2e-state/` (git-ignored). With `TABSTRIP_WRITE_DOCS=1` the 1.15.0 run writes them into `docs/verification/` instead (the maintainer's test reports, which are not part of the public repository).
- The look cases install four community themes into the sandbox vault (Atom, Cupertino, Blue Topaz, Minimal). `wdio.conf.mts` reads them from your own vault's `.obsidian/themes/` and copies them into the git-ignored `test/themes/`, never writing to the vault.
- `npm run spike:s1` and other configs passed with `--config` must import the root `wdio.conf.mts` (which holds the sandbox interlocks) and build on its `config`; `scripts/config-guard.mjs` parses the config to check this and refuses anything else.

## Trying it by hand

`npm run try` opens the plugin in a visible sandbox Obsidian (its own throwaway `HOME`, config and vault copy, host checks before and after); quit it with Cmd+Q. Quitting deletes the throwaway config, local storage and vault copy, so the next `npm run try` starts fresh. To check that something survives a restart, run Obsidian's "Reload app without saving" command inside the same sandbox instead (it keeps the config directory), a few seconds after the change.

- `npm run try -- --vertical` opens it already in vertical tabs, with a few notes open, three groups (one collapsed) and a pinned tab (a development-only seed plugin, `scripts/try-seed`, installed only into the throwaway vault copy).
- `npm run try -- --version 1.14.4` picks another Obsidian version.

## Local settings

Some checks need the path of your own Obsidian vault: the host guard always checks it (even if `obsidian.json` stops listing it), and a few e2e cases copy its themes and window settings (read only). Put it in a git-ignored `.tabstrip-local.json` at the repo root, or set `TABSTRIP_MAIN_VAULT`:

```json
{ "mainVault": "/path/to/your/vault" }
```

Without it, the guard checks only the vaults `obsidian.json` lists, the theme cases use copies already in `test/themes/`, and the vertical frame case (`v1-mount` M6/M7) stops with a message.

## Releasing

1. Update `CHANGELOG.md`.
2. `npm version <x.y.z>` updates `package.json`, `manifest.json` and `versions.json` and makes a tag without a `v` prefix (`.npmrc` sets `tag-version-prefix=""`).
3. Push the tag. The `Release` workflow (`.github/workflows/release.yml`) checks that the tag matches the manifest version, builds with `npm ci && npm run build`, and creates a **draft** GitHub release with `main.js`, `manifest.json` and `styles.css`.
4. Check the draft, write the release notes from the changelog, and publish it.

The first release, 0.2.0, skips step 2: `package.json`, `manifest.json` and `versions.json` already say 0.2.0, so `npm version 0.2.0` would stop with "Version not changed". Tag the release commit by hand instead (`git tag 0.2.0`) and go on with step 3.

