# Excalidraw Visualizer

[![CI](https://github.com/magnuslandahl/ExcalidrawVisualizer/actions/workflows/ci.yml/badge.svg)](https://github.com/magnuslandahl/ExcalidrawVisualizer/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/magnuslandahl/ExcalidrawVisualizer?include_prereleases&label=release)](https://github.com/magnuslandahl/ExcalidrawVisualizer/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Excalidraw Visualizer is a local, offline Electron editor and live viewer for
`.excalidraw` files. Open a drawing, edit it normally, and leave the window open while an
AI agent or another program updates the same file. Valid external changes appear on the
canvas automatically; overlapping local and external edits require an explicit conflict
decision.

The JSON file remains the source of truth. Saves use normal Excalidraw version-2 JSON,
safe same-directory replacement, and stable content fingerprints so the application does
not react to its own writes.

## Download

| Platform | Download |
| --- | --- |
| Windows 10/11 x64 installer | [ExcalidrawVisualizer Windows x64 Setup](https://github.com/magnuslandahl/ExcalidrawVisualizer/releases/download/latest/ExcalidrawVisualizer-Windows-x64-Setup.exe) |
| Windows 10/11 x64 portable | [ExcalidrawVisualizer Windows x64 Portable](https://github.com/magnuslandahl/ExcalidrawVisualizer/releases/download/latest/ExcalidrawVisualizer-Windows-x64-Portable.exe) |
| macOS 13+ on Apple silicon (M-series) | [ExcalidrawVisualizer macOS arm64 DMG](https://github.com/magnuslandahl/ExcalidrawVisualizer/releases/download/latest/ExcalidrawVisualizer-macOS-arm64.dmg) |
| macOS 13+ on Intel | [ExcalidrawVisualizer macOS x64 DMG](https://github.com/magnuslandahl/ExcalidrawVisualizer/releases/download/latest/ExcalidrawVisualizer-macOS-x64.dmg) |

The links above target the rolling release tag named `latest`. GitHub's
**Latest** stable release is the immutable first public version,
[v0.1.0](https://github.com/magnuslandahl/ExcalidrawVisualizer/releases/tag/v0.1.0).

The packages are currently unsigned for distribution.

- **Windows:** SmartScreen may show **Windows protected your PC**. Choose
  **More info**, then **Run anyway**. Managed-device policy may block unsigned
  applications completely.
- **macOS:** Open the DMG, drag **Excalidraw Visualizer** to **Applications**,
  and try to open it once. After macOS blocks it, open **System Settings →
  Privacy & Security**, scroll to **Security**, and choose **Open Anyway**.
  Each DMG includes a **How to open this app** file with the same steps. If
  macOS instead says the app is damaged, do not move it to the Trash; run:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/Excalidraw Visualizer.app"
  ```

  Do not disable Gatekeeper system-wide. The current ad-hoc signature makes the
  bundle internally runnable but does not provide Apple-verified publisher
  identity or notarization.

## Features

- Native open, save, save-as, reload, recent-files, drag-and-drop, and keyboard shortcuts
- Multiple mounted document tabs with independent viewport, undo, autosave, watcher,
  conflict, and dirty state
- A single compact tab/action row with flexible filename widths, explicit
  **View/Edit** control, and an overflow menu for less-used actions; drawings
  open in viewing mode
- Drag a tab into a side-by-side pane, or move a saved clean tab into another secured
  application window from its context menu
- Launch-path handling, single-instance forwarding, and packaged `.excalidraw` association
- Chokidar-based watching for direct writes, atomic replacement, deletion, and recreation
- SHA-256 application-write echo suppression
- Last-valid-scene behavior while external JSON is malformed or partially written
- Element-aware three-way merging by stable Excalidraw IDs and version metadata
- Explicit conflict choices: keep local, load external, or save local separately
- Embedded image/file-map preservation and merging
- Explicit Fit to Content without resetting the viewport on normal external updates
- System, light, and dark application themes with a remembered preference
- Running version and an explicit, checksum-verified update control in the overflow menu
- Arbitrary canvas background colors saved as normal Excalidraw document state
- Standard Excalidraw stroke and fill palettes whenever an element is selected
- A canvas-first **Give feedback** mode that hides application chrome, enters
  Excalidraw zen mode, and keeps only a compact recorder over the drawing
- Automatic feedback context from bounded pointer movement, hovered element IDs,
  click order, and relative timing; overlays never enter the `.excalidraw` file
- Explicit one-time pairing with the current GitHub Copilot task, with separate
  queue/send-now delivery, admission receipts, replies, blocked state, and result history
- Bundled offline English, Swedish, and automatic-language dictation using a pinned
  `whisper.cpp` helper, multilingual model, and Silero VAD
- Fully local JavaScript, CSS, worker chunks, and Excalidraw fonts

## Local feedback and GitHub Copilot pairing

Open **Give feedback** on a drawing from the tab row. Visualizer temporarily hides
the tab/action row and asks Excalidraw to use zen mode so the canvas stays visible.
Start dictating and interact naturally with the drawing. Visualizer samples pointer
movement and hovered element IDs and records click order and relative timing even
while the viewing canvas pans. Clicked elements become the feedback target
automatically; if nothing is clicked, the target
remains the whole drawing. No target picker is required. **Copy for agent** puts a
revision-labelled text submission on the clipboard, so the local workflow also works
without pairing an agent.

The feedback composer also supports local dictation. Choose **English**, **Svenska**,
or **Auto language**, start recording, and interact with the canvas. When paired,
one **Send feedback** action stops recording, transcribes locally, sends immediately,
clears the completed message, and leaves the panel ready for the next recording.
Without pairing, **Finish dictation** keeps the editable transcript for copying.
The panel collapses to a compact recorder during capture. Audio is converted to
bounded PCM, processed locally with VAD, and removed after completion, cancellation,
or failure. Existing typed text is preserved when microphone permission or
transcription fails.

To deliver feedback directly to the intended GitHub Copilot task:

1. In Visualizer, open **Give feedback** and choose **Install Copilot companion**.
   Restart GitHub Copilot or open a new task after installation or an update.
2. Open the **Excalidraw Visualizer Companion** canvas in the intended Copilot
   task.
3. Choose **Copy one-time pairing code**.
4. In Visualizer, paste the code under **Copilot task** and pair.
5. Compose feedback and choose **Queue** for normal follow-up or **Send now** to
   steer the paired task immediately. Immediate feedback explicitly asks the agent
   to make narrow changes with focused inspection and validation instead of turning
   a small edit into a broad audit.

The installer copies the companion shipped with Visualizer into the current
user's Copilot extension directory, so it is available from every repository.
It honors `COPILOT_HOME` when configured and otherwise uses the standard
`.copilot` directory in the user's home directory. Visualizer updates only
copies that it installed itself and refuses to overwrite an extension with the
same name that is managed separately. Contributors working in this repository
also receive the checked-in project extension automatically; that project copy
takes precedence over the user-wide copy for this checkout.

Pairing capabilities expire after five minutes and connection secrets remain in memory
only. Restarting either side requires explicit re-pairing. **Accepted** means Copilot
admitted the message; consumed, reply observed, and idle-after-turn are reported
separately and do not claim that a requested file change was correct or accepted.
Unknown admissions are never replayed automatically and must be retired explicitly
before later queued work can continue.

Visualizer does not scan, infer, activate, or create Copilot tasks. The tested host
exposes no supported global task discovery route, so pairing must begin inside the
intended task. The [agent feedback proposal](docs/AGENT-FEEDBACK-PROPOSAL.md) and
[Stage 0 capability record](docs/AGENT-FEEDBACK-STAGE0.md) document that boundary.

## Version and updates

The application header shows the running semantic version. **Check for updates**
is manual: Visualizer makes no update request at startup and remains fully usable
offline. When clicked, it checks the rolling `latest` release in this GitHub
repository and shows **No update available** when the running version is current.

For a newer version, the same control downloads the correct Windows x64 or macOS
architecture package, verifies it against the release's `SHA256SUMS.txt`, and
installs it. Windows launches the per-user NSIS upgrade. A writable installed
macOS application stages and swaps the verified app bundle, then reopens it; a
copy that cannot replace itself opens the verified DMG instead. Visualizer refuses
to start installation while any drawing has unsaved changes or an unresolved
conflict.

Update traffic is limited to the public GitHub release API and immutable release
assets after the user clicks the control. No drawing, feedback, or application
state is included in those requests.

## Requirements

- Node.js 20.19 or newer (Node.js 22.12+ is also supported by the build toolchain)
- npm
- Git and CMake when packaging the macOS dictation helper
- Windows 10/11 for Windows installer creation
- macOS 13 Ventura or newer for macOS disk-image creation

All dependency versions are pinned in `package.json` and resolved in
`package-lock.json`.

## Development

```powershell
npm ci
npm run dev
```

`npm run dev` copies the pinned Excalidraw font assets into the Vite public directory
before starting Electron. The generated asset directory is intentionally ignored because
it is reproducibly populated from the locked npm package.

### Quality checks

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Or run the test, type-check, and lint steps together:

```powershell
npm run check
```

Watcher tests use temporary directories and observable events with bounded timeouts rather
than fixed sleeps.

## Production build and packaging

Build unpackaged production resources:

```powershell
npm run build
```

Create packages for the current operating system:

```powershell
npm run package
```

Create a specific platform's packages:

```powershell
npm run package:win
npm run package:mac
```

Packaging runs `npm run prepare-whisper`, downloads approximately 489 MB of pinned model
assets, verifies exact byte sizes and SHA-256 hashes, and either extracts the pinned
Windows x64 helper or compiles a universal macOS helper. Generated inputs stay under the
ignored `vendor/whisper/` directory. Packaged applications include the component license
notices from `build/WHISPER-NOTICES.txt`.

Create only an unpacked application directory:

```powershell
npm run package:dir
```

Production renderer and Electron outputs are written to `out/`. Packaged artifacts are
written to `release/`. The builder configuration sets:

- Product name: `Excalidraw Visualizer`
- Executable: `ExcalidrawVisualizer.exe`
- Windows targets: x64 NSIS installer and x64 portable executable
- macOS targets: Apple silicon and Intel x64 DMGs for macOS 13 or newer
- `.excalidraw` file association
- a bundled Copilot companion that can be installed user-wide from the Give feedback
  panel

The current builds use a simple project icon from `build/`; it can be replaced with final
branding without changing the package layout. Production signing and macOS notarization
are not configured. macOS bundles receive only a local ad-hoc signature after packaging;
Apple Developer ID signing, hardened runtime, notarization, and stapling remain required.

## Opening files

Use any of these paths:

- **File > Open**, `Ctrl+O` on Windows, or `⌘O` on macOS
- The **Open** button on the welcome screen or header
- Drop one or more `.excalidraw` files onto the application window
- Launch `ExcalidrawVisualizer.exe C:\path\drawing.excalidraw`
- Launch the macOS app with `/Applications/Excalidraw\ Visualizer.app/Contents/MacOS/ExcalidrawVisualizer /path/drawing.excalidraw`
- Open an associated `.excalidraw` file after installing the packaged application

A second application launch forwards its file to the existing window and focuses it.
Opening another file creates or activates its tab without disturbing dirty state in the
other mounted editors. For a file-backed document, **Save As** to another canonical path
creates a separate tab and document identity; feedback remains with the original.
Drag a tab to the side-view target to compare two drawings. Right-click a saved tab
with no pending edits to move it into another secured application window.

## Colors and appearance

Drawings open in **View** mode for panning, zooming, and feedback without editing.
Choose **Edit** in the tab row to reveal Excalidraw's editing controls; choose
**View** to return to the viewing layout. This mode is local to the window and
does not change the drawing. The tab row shows status for the focused drawing;
hover a tab for its full path. **More actions** contains New, Open, Save,
Save As, Fit to Content, Reload, theme, the update control, and app version.
The native File/Edit/View menu and shortcuts remain available.

The overflow menu contains two appearance controls:

- **Theme** changes the application and Excalidraw UI between System, Light, and Dark.
  This preference is local to the application and does not modify the drawing.
- **Canvas** appears in Edit mode and opens the system color picker for the
  current drawing background. The chosen
  value is saved as `appState.viewBackgroundColor` in the `.excalidraw` file, so it remains
  compatible with excalidraw.com and other Excalidraw editors.

Select a shape, arrow, line, or text element to use Excalidraw's normal stroke, fill, and
text color controls. The Excalidraw main menu also retains its canvas background and theme
actions.

## External watcher behavior

The main process watches the active file's parent directory so replacement-by-rename is
observed as reliably as direct writes. Each candidate is read and fingerprinted:

1. A fingerprint matching an application write is ignored as an echo.
2. Duplicate filesystem events with identical content are ignored.
3. Valid version-2 Excalidraw JSON is sent through the narrow preload bridge.
4. Invalid or incomplete JSON leaves the last valid canvas untouched and displays the
   parse error.
5. Watching continues, so a later valid write recovers automatically.
6. Deletion reports **File missing** while the directory watcher waits for recreation.

Normal external updates preserve current zoom, scroll position, selection, active tool,
and relevant UI state where the Excalidraw API permits. Fit to Content is only performed
on request.

## Merge and conflict semantics

The renderer tracks three scenes:

- **Base**: the last synchronized disk scene
- **Local**: the current edited scene
- **External**: the newly observed disk scene

Elements are compared by stable ID and full versioned content. If only local or only
external changed an element relative to base, that change is accepted. Additions and
changes to different elements merge automatically. Embedded `files` entries use the same
three-way rule by file ID.

A conflict is raised when local and external both incompatibly modify the same element or
file, or when one side deletes an item the other side modifies. No winner is selected
silently. The dialog identifies the conflicting count and element IDs and offers:

- **Keep local version**: intentionally save the local scene over the active file
- **Load external version**: discard overlapping local changes
- **Save local as a separate file**: preserve the local scene at a new path and leave the
  externally updated original untouched

## Safe updates from an AI agent

An agent should:

1. Read and parse the current file before editing.
2. Preserve `type: "excalidraw"`, `version: 2`, existing element IDs, and embedded `files`.
3. For a changed element, increment `version` and use a new `versionNonce`.
4. Add new elements with unique stable IDs.
5. Write complete JSON to a temporary file in the same directory, flush it, then replace
   the target atomically.
6. Never stream partial JSON directly into the target if atomic replacement is available.
7. Avoid reformatting or reordering unrelated content solely for style.

The application tolerates temporary invalid content, but atomic replacement produces the
cleanest watcher and Git behavior.

## Offline guarantee

After installation, drawing, editing, feedback drafting, persistence, and dictation do
not require a development server, CDN, hosted Excalidraw service, or network API.
Excalidraw JavaScript, styles, lazy chunks, workers,
and fonts are bundled in the application. The production build removes Excalidraw's
upstream CDN font fallback so missing local assets fail closed instead of attempting a
network request. Optional Copilot delivery uses only an authenticated loopback
connection to the explicitly paired task-local companion. Visualizer sends no request
to a remote endpoint; the Copilot host may process the feedback through its configured
service after the user chooses Queue, Send now, or the recording-time **Send
feedback** action. Only the frozen feedback text, target metadata, bounded interaction
trace, opaque document identity, readable filename, and revision are sent; the
drawing file and dictation audio are not uploaded by Visualizer.

The renderer denies remote window creation and navigation. Electron permissions are
denied except for an audio-only microphone request from the trusted renderer after the
user starts dictation. The Content Security Policy
allows only application resources, data/blob media, and the localhost WebSocket used by
the development server.

The application does not add telemetry, update checks, or general outbound network
access.

## Automated releases and versioning

GitHub Actions follows the same public-release pattern as FeedbackRecorder:

- Pull requests and `main` run tests, type-checking, linting, Windows and macOS
  packaging smoke tests, and Gitleaks scans of files and Git history.
- The macOS smoke test launches the packaged native app, opens real document tabs,
  checks both canvas layers, exercises an external atomic update, application save,
  persisted feedback, copy recovery, and bundled offline dictation, and rejects
  renderer errors or remote requests.
- Every push to `main` refreshes the rolling `latest` release and uploads
  fixed-name Windows and macOS downloads.
- A semantic version tag such as `v0.2.0` publishes a permanent release whose filenames
  include that version.
- `v0.1.0` is the permanent first public release; `latest` continues to move with
  validated changes on `main`.
- Every release contains `SHA256SUMS.txt`; build artifacts are also retained by Actions
  for 14 days.

The version in the Git tag must match `package.json`. Bump both npm manifests together:

```powershell
npm version patch --no-git-tag-version
npm run release:check-version -- v0.1.1
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution and release flow,
[AGENTS.md](AGENTS.md) for the detailed product, architecture, and safety briefing, and
[TODO.md](TODO.md) for the active handoff queue. Apple Developer ID signing and
notarization are the next macOS distribution priorities.

## Architecture

```text
src/
  main/       Electron lifecycle, document registry, persistence, dictation, filesystem
  preload/    Narrow typed contextBridge API
  renderer/   React shell and official Excalidraw component
  shared/     IPC contracts, scene validation, renderer-independent three-way merge
tests/        Vitest unit and temporary-directory integration tests
scripts/      Reproducible Excalidraw and Whisper asset preparation
build/        Application and file-association icons
.github/      Pull-request CI and rolling/versioned release workflows
```

Security boundaries:

- `contextIsolation: true`
- `nodeIntegration: false`
- sandboxed renderer
- no general filesystem, shell, or raw IPC API exposed to the renderer
- filesystem paths and extensions validated in the main process
- save payloads reparsed and validated before writing
- remote navigation and popups denied; permissions denied except explicit audio-only
  microphone capture for local dictation

## Known limitations

- Only version-2 `.excalidraw` JSON documents are accepted.
- Same-element concurrent property edits are treated as conflicts rather than attempting
  a risky property-level merge.
- The watcher reflects the latest stable content exposed by the operating system; a
  program that performs several complete writes faster than filesystem notifications can
  be delivered may expose only the final state.
- Windows packages are not code-signed, so SmartScreen may warn or
  managed-device policy may block them.
- macOS packages are ad-hoc signed but not Developer ID signed or notarized, so
  Gatekeeper blocks the first launch until the user explicitly approves it.
- Copilot delivery requires explicit task-originated pairing for each app/provider
  session; Visualizer cannot discover or activate arbitrary tasks.
- Linux packaging is not configured.

## License

[MIT](LICENSE)
