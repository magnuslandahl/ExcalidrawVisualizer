# Agent instructions

This file is the durable briefing for people and coding agents working on
Excalidraw Visualizer. Read it before changing the application, build, release
configuration, or documentation.

## Public repository safety

This repository is public at:
`https://github.com/magnuslandahl/ExcalidrawVisualizer`.

Treat every tracked file, commit, branch, tag, commit message, issue, pull
request, workflow log, and release artifact as visible to everyone.

Before every commit:

- Review `git status --short`, the complete staged diff, and new binary files.
- Look for credentials, API keys, access tokens, private keys, connection
  strings, internal URLs, local absolute paths, usernames, email addresses,
  company data, customer data, drawings, screenshots, logs, crash dumps, and
  recent-file state.
- Run `gitleaks git --staged --no-banner` when Gitleaks is available. CI scans
  both the working tree and the complete pushed history, but CI is a backstop,
  not permission to skip manual review.
- Never commit `.env` files, local configuration, signing certificates,
  passwords, recordings, private drawings, generated installers, application
  state, or files from another repository.
- Use generic examples such as `C:\drawings\architecture.excalidraw`, never a
  real local path.
- Keep generated content under `out/`, `release/`, `coverage/`, or the ignored
  renderer asset directory. Do not force-add it.
- If a real secret has been committed, stop. Revoke or rotate it first, then
  remove it from every reachable Git ref. A later deletion commit is not enough.

Use the public GitHub noreply identity configured for this repository. Do not
reintroduce a workplace email address into commit metadata.

## What this project is

Excalidraw Visualizer is a desktop editor and live viewer for version-2
`.excalidraw` JSON files. It is designed for a workflow where a person and a
local AI coding agent may both update the same diagram:

1. A person opens a drawing and edits it with the official Excalidraw UI.
2. The application saves normal `.excalidraw` JSON atomically.
3. An agent or another local program can update the file on disk.
4. The open application detects the change and updates the canvas without
   destroying the person's viewport or unrelated work.
5. Non-overlapping changes merge automatically. Overlapping changes require an
   explicit choice.

The file on disk is the source of truth. The application is not a hosted
collaboration service, does not create its own document format, and does not
depend on an account, cloud backend, telemetry service, or CDN.

## Original brief and alignment

The project began from a production-quality implementation brief, not a
prototype request. The original requirements were:

- Build a native-feeling Electron application around the official Excalidraw
  component.
- Open, edit, save, save as, reload, drag and drop, and launch
  `.excalidraw` files from the operating system.
- Watch the active file continuously, including direct writes, atomic
  replacement, deletion, recreation, and temporarily malformed JSON.
- Avoid reacting to the application's own writes without relying on timing
  windows.
- Preserve zoom, scroll, selection, active tool, and other local view state when
  external content arrives.
- Merge independent local and external changes by stable element and embedded
  file IDs.
- Never silently pick a winner when the same element is changed incompatibly.
- Save safely through same-directory temporary files and atomic replacement.
- Keep the renderer sandboxed and expose only a narrow typed preload API.
- Bundle all runtime assets locally and work without a network connection.
- Package an installer and a portable executable for Windows.
- Add focused tests, public documentation, and an agent-oriented explanation of
  safe file updates.
- Inspect neighboring desktop projects for conventions without modifying them.
- Do not create commits or push changes unless the user explicitly asks.

The neighboring FeedbackRecorder repository is the reference for public
repository discipline and release behavior: pull-request CI, secret scanning,
retained workflow artifacts, a rolling `latest` release from `main`, permanent
version tags, checksums, and clear unsigned-package warnings. This project
adopts those principles but remains Windows-first because that is the platform
required and tested by its original brief.

## Product principles

### Local and offline

- No application feature may require a remote server.
- Do not add telemetry, analytics, update checks, remote fonts, or CDN assets.
- Network navigation, popup creation, and Electron permission requests remain
  denied.
- Local files may contain private architecture and product information. Never
  upload, index, or transmit drawing content.

### Compatible files

- Read and write ordinary Excalidraw version-2 JSON.
- Preserve element IDs, version fields, embedded file maps, and unknown
  compatible properties.
- Do not invent an application-specific wrapper format.
- Serialization should exclude transient local viewport state while preserving
  document state such as the canvas background.

### Explicit conflicts

- Automatic behavior is allowed only when the merge is unambiguous.
- A local deletion versus an external modification is a conflict.
- An external deletion versus a local modification is a conflict.
- Two incompatible edits to the same element or embedded file are conflicts.
- Conflict previews may show local content, but nothing conflicting is written
  until the person chooses a resolution.

### Secure Electron boundaries

Keep these invariants:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- no raw `ipcRenderer`, shell, process, or filesystem object in the renderer
- all filesystem access in the main process
- path, extension, and payload validation in the main process
- navigation, popups, and permission requests denied by default
- a restrictive Content Security Policy

Do not weaken sandboxing to work around build problems. The preload must remain
CommonJS (`out/preload/index.cjs`) because a sandboxed Electron preload cannot
execute the emitted ESM preload bundle.

## Current user experience

- The welcome view opens files through a button or drag and drop.
- The header shows the active file, full path, save/watch status, application
  theme selector, canvas background color picker, Open, Fit to Content, and
  Reload.
- Application appearance can be System, Light, or Dark and is remembered
  locally.
- Canvas background color is document state and is saved in the
  `.excalidraw` file.
- Selecting an element exposes Excalidraw's normal stroke and fill color
  controls. The main Excalidraw menu also retains its canvas background and
  theme actions.
- Autosave is debounced. `Saved` is shown only after the main process confirms
  a successful write.
- Errors and watcher states are visible; malformed external content never
  replaces the last valid scene.
- Conflicts offer Keep local, Load external, and Save local as a separate file.

The application layout uses explicit CSS grid rows for the header, optional
banner, and workspace. Do not return to implicit placement: when the banner is
absent, implicit placement puts the workspace in the zero-height `auto` row and
the Excalidraw canvas renders blank.

## Architecture

```text
.github/workflows/
  ci.yml                 Cross-platform checks, Windows packaging smoke, secrets
  release.yml            Rolling and tagged Windows release publishing
DIAGRAM-DESIGN-GUIDELINES.md
                          Visual language for overview and detailed architecture drawings
TODO.md                   Current handoff queue and platform roadmap
build/                    Application and file-association icons
scripts/
  check-release-version  Enforces tag/package version agreement
  copy-excalidraw-assets Copies pinned local Excalidraw fonts
src/
  main/                   Trusted Electron and filesystem boundary
  preload/                Narrow contextBridge API
  renderer/               React shell and official Excalidraw component
  shared/                 IPC contracts, validation, merge logic
tests/                    Pure and temporary-filesystem Vitest coverage
electron-builder.yml      Windows installer and portable package configuration
electron.vite.config.ts   Main, sandbox preload, renderer, offline font transform
```

### Main process

`src/main/index.ts` owns Electron lifecycle:

- obtains the single-instance lock
- creates the secured `BrowserWindow`
- registers typed IPC handlers
- handles initial command-line paths, second-instance paths, and `open-file`
- waits for an explicit renderer-ready handshake before delivering a launch path
- guards navigation, new windows, permissions, and dirty-window quitting

`src/main/document-controller.ts` owns the active document:

- validates `.excalidraw` paths
- opens, reloads, saves, and saves as
- updates recent files
- switches the watcher when the active path changes
- emits typed document events to the renderer

`src/main/atomic-write.ts` writes a temporary file in the destination directory,
flushes it, replaces the destination, and preserves its mode when supported.
Keep temporary and destination files on the same filesystem so rename remains
atomic.

`src/main/file-watcher.ts` watches the parent directory rather than only the
file. This is necessary because many tools save by renaming a replacement over
the original path. The watcher:

- waits for writes to settle
- reads and fingerprints complete content
- suppresses known application writes and duplicate events by SHA-256
- reports malformed JSON without accepting its fingerprint
- continues watching after malformed content or deletion
- recognizes valid recreation and recovery

Do not replace content fingerprints with a debounce-only or timestamp-only
scheme. Timing guesses caused exactly the class of stale/duplicate behavior this
design avoids.

### Preload

`src/preload/index.ts` exposes only `window.desktop`, a typed API for:

- open/open-path/reload
- save/save-as
- recent files
- dirty-state reporting
- renderer-ready launch-path handoff
- document and menu command subscriptions
- safe dropped-file path retrieval

Adding a renderer capability requires updating the shared contract, preload,
main handler, validation, and tests together.

### Renderer

`src/renderer/src/App.tsx` owns document UI state:

- base, current, and conflict scene references
- Excalidraw imperative API integration
- normalized open/external scenes
- debounced save scheduling and in-flight save reconciliation
- viewport-preserving external updates
- theme and canvas color controls
- drag and drop, commands, banners, and conflict actions

Use Excalidraw's `restore()` before applying imported data and
`serializeAsJSON(..., "local")` when producing saved scene JSON.

Use `CaptureUpdateAction.NEVER` for remote/watcher updates so they do not pollute
the local undo stack. Use `CaptureUpdateAction.IMMEDIATELY` for explicit local UI
actions such as changing the canvas background.

When the embedded `files` map changes, remount the editor with preserved
viewport state. `api.addFiles()` does not reliably replace an existing file that
has the same ID.

`src/renderer/src/bootstrap.ts` must run before importing Excalidraw. It gives
Excalidraw an absolute packaged `file://` asset base.

### Shared scene and merge logic

`src/shared/scene.ts` accepts only object-root, version-2 Excalidraw scenes with
valid element identity/version fields and object app/file maps. It intentionally
keeps unknown compatible properties.

`src/shared/merge.ts` is renderer-independent:

- comparisons use stable object-key ordering
- elements merge by stable ID
- file entries merge by file ID
- one-sided changes are accepted
- equivalent two-sided changes are accepted once
- incompatible two-sided changes produce IDs for the conflict UI

Keep merge logic pure and covered by unit tests. Do not import React, Electron,
or browser APIs into shared merge modules.

## Offline assets

Excalidraw's production fonts are copied from the pinned npm package into
`src/renderer/public/excalidraw-assets/` before development and production
builds. That generated directory is ignored.

Excalidraw 0.18.1 appends an `esm.sh` font URL even when a local asset path is
configured. `electron.vite.config.ts` removes that fallback during the renderer
build. The transform intentionally fails the build if the expected upstream
shape changes or a remote fallback remains. Keep this fail-closed behavior when
upgrading Excalidraw, and verify the resulting app with a network log.

## Development workflow

Requirements:

- Node.js 20.19 or newer
- npm
- Windows 10/11 for Windows package creation

The dependency, quality-check, build, and development commands are expected to
be cross-platform. Windows is still the only packaged and advertised target.
The next platform task is to validate and package the application on macOS;
follow `TODO.md` and do not claim macOS support before completing its packaged
runtime checks.

Install and run:

```powershell
npm ci
npm run dev
```

Run all local checks:

```powershell
npm run check
npm run build
```

Build Windows packages:

```powershell
npm run package:dir
npm run package
```

Outputs:

- `out/` contains compiled Electron and renderer resources.
- `release/win-unpacked/` contains the unpacked application.
- `release/*.exe` contains the installer and portable executable.

These paths are generated and ignored.

## Testing expectations

The focused Vitest suite currently covers:

- own-write and duplicate fingerprint suppression
- direct-write watcher detection
- atomic-replacement watcher detection
- invalid JSON followed by valid recovery
- non-overlapping element merges
- incompatible same-element edits
- deletion-versus-modification conflicts
- embedded file-map merging
- dirty-document merge behavior

Use temporary directories and observable events for watcher tests. Do not add
fixed sleeps as the assertion mechanism.

For renderer or layout changes, also verify a packaged application:

- a real window appears
- the sandboxed preload loads
- a launch-path file opens
- the workspace and both canvas layers have non-zero dimensions
- no renderer resource errors appear
- no remote network request is attempted

Add a regression test when logic can be isolated. A screenshot or successful
process launch alone does not prove that the editor rendered.

## Versioning and releases

The package follows semantic versioning through the `version` field in
`package.json` and `package-lock.json`.

The first public version is `0.1.0`. GitHub publishes it through two release
references:

- `latest` is the moving release tag rebuilt from the current `main`; fixed
  download links must use `/releases/download/latest/<asset>`.
- `v0.1.0` is the permanent first-version release, is marked as GitHub's
  **Latest** stable release, and must never be moved.

- Patch: compatible bug fixes.
- Minor: compatible user-facing features.
- Major: incompatible file, behavior, or platform changes.

Use npm to change both manifests together:

```powershell
npm version patch --no-git-tag-version
```

The release workflow has two channels:

- Every push to `main` builds a rolling GitHub release tagged `latest`. Its file
  names remain stable so README download links do not break.
- A tag such as `v0.2.0` creates a permanent release whose file names include
  the package version. The workflow rejects a tag that disagrees with
  `package.json`.

Both channels build:

- Windows x64 NSIS installer
- Windows x64 portable executable
- `SHA256SUMS.txt`

Workflow artifacts are retained for 14 days even before release publication.
Packages are currently unsigned; documentation must keep the SmartScreen
warning visible until signing is actually configured and verified.

Do not advertise macOS, Linux, ARM64, auto-update, or signed packages until each
target is configured, tested on the target platform, and added to CI.

## CI and repository settings

`.github/workflows/ci.yml` runs:

- tests, type-checking, and linting on Windows, macOS, and Linux
- an unpacked Windows packaging smoke test
- Gitleaks against both files and complete Git history
- a single aggregate `CI` result suitable for branch protection

Configured GitHub settings:

- public repository at `magnuslandahl/ExcalidrawVisualizer`
- default branch `main`
- require pull requests before merge
- require the `CI` status check
- dismiss stale approvals when new commits are pushed
- block force pushes and branch deletion on `main`
- enable Dependabot security updates and secret scanning

`origin` points to the public repository. `main` is protected, including for
administrators, so normal changes must be pushed to a short-lived branch,
validated in a pull request, and merged only after the aggregate `CI` check
passes. Do not rewrite or move the permanent `v0.1.0` tag.

## Documentation responsibilities

Update `README.md` whenever user-visible behavior, supported platforms,
installation steps, commands, downloads, or limitations change.

Update this file whenever architecture, safety rules, invariants, release
policy, or the active plan changes.

Examples in public documentation must be synthetic and must not name a real
company, customer, private repository, workstation, or drawing.

## Current state

Implemented:

- secure Electron main/preload/renderer boundaries
- version-2 scene validation
- open, recent files, drag/drop, launch paths, save, save as, reload
- atomic writes with permission preservation
- directory watcher with malformed-file recovery
- SHA-256 echo and duplicate suppression
- official Excalidraw editing UI with local fonts
- application theme selection and arbitrary canvas background colors
- viewport-preserving external updates
- element/file three-way merge and explicit conflict resolution
- focused tests, linting, strict TypeScript, Windows packaging
- public CI, secret scanning, rolling releases, tagged releases, checksums
- public repository, protected `main`, rolling `latest`, and permanent `v0.1.0`

Near-term plan:

1. Add tested macOS development, packaging, CI, and release support. This work
   is planned in `TODO.md` and has not started.
2. Add Windows code signing when a certificate is available.
3. Replace placeholder application/file icons with final original artwork.
4. Add a packaged renderer smoke test to CI, including non-zero canvas
   dimensions and offline network assertions.
5. Add privacy-safe screenshots after final branding is available.
6. Gather public feedback before expanding the merge model further.

Possible later work, not current commitments:

- property-level merging within a single element
- Linux AppImage packages
- Windows ARM64 packages
- opt-in update notifications backed by GitHub Releases

## Change checklist

Before declaring work complete:

1. Read the affected main, preload, renderer, and shared boundaries.
2. Preserve the security and offline invariants.
3. Make the smallest complete change.
4. Run the narrowest relevant tests, then `npm run check`.
5. Build/package when runtime, Electron, assets, or release files changed.
6. Review `git diff --check`, `git status --short`, and ignored/generated files.
7. Scan for secrets and personal data.
8. Update README and this briefing when behavior or policy changed.
9. Update `TODO.md` when an item is completed, added, or reprioritized.
10. Do not commit, tag, create releases, or push unless explicitly asked.
