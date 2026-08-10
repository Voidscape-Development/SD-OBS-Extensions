# OBS Extensions

A Stream Deck plugin for driving OBS Studio over obs-websocket, with an
optional companion OBS plugin that makes hotkey control exact rather than
approximate.

Two pieces live in this repository:

| Path | What it is |
| --- | --- |
| `src/`, `dev.voidscape.obs-extensions.sdPlugin/` | The Stream Deck plugin (TypeScript). |
| `obs-plugin/` | The optional companion OBS Studio plugin (C). |

The Stream Deck plugin works on its own. The companion is a strict upgrade —
see [Why the companion exists](#why-the-companion-exists).

## Actions

### OBS Connection

Manages the plugin's OBS instances. Stream Deck has no plugin-level settings
screen, so this action's property inspector is where connections are added,
edited and removed; every other action just picks one from a dropdown. Placed
on a key it also works as a connect/disconnect toggle with live status.

The key has a single state, and its title and image are re-derived from the
live connection status every time that status changes. A second state would be
Stream Deck's to flip as well as the plugin's — it advances on every press,
whether or not the connection came up — which is how a key could end up
claiming to be connected when it was not.

Connections are held open with automatic reconnection and exponential backoff,
so pressing a trigger key fires immediately rather than paying for a handshake.

### OBS Trigger

A single-state, fire-and-forget key. Three things it can do against a chosen
instance:

- **Global hotkey** — OBS's frontend hotkeys (start/stop streaming, recording,
  replay buffer, virtual camera, studio mode, screenshots, and so on).
- **Source hotkey** — hotkeys belonging to a specific source, picked from an
  alphabetical source list: mute/unmute and push-to-talk on audio sources,
  play/pause/restart on media and VLC sources, refresh on browser sources.
- **Filter** — enable or disable a filter on any source or scene.

Firing a hotkey tells the plugin nothing about what happened inside OBS, so the
key has nothing to report back: it shows one look, styled once, and flashes the
standard OK or alert on the press itself. Toggling, and seeing state, is the
OBS Filter action's job.

### OBS Filter

Toggles one filter on a source or scene, and shows whether that filter is
currently on.

This is the one thing the plugin can genuinely track, so it is the one action
with two states. They are driven only by what OBS reports — through
`SourceFilterEnableStateChanged` events, and by re-reading the filter whenever
the key appears or the connection comes back — never by the press itself.
Stream Deck's own automatic state switching is turned off for this action, so a
filter flipped from inside OBS, from a second key, or by another client lands
on the key correctly, and a press that fails leaves the key showing the truth.

## Why the companion exists

obs-websocket's `GetHotkeyList` returns a flat list of bare internal hotkey
names — no descriptions, no owning context, no de-duplication. Every audio
source contributes an identical `libobs.mute` entry and nothing says which
source it belongs to, so "pick a source, then pick its hotkey" cannot be built
from the API alone.

The plugin therefore has two hotkey backends, chosen automatically per
connection:

| | Without companion | With companion |
| --- | --- | --- |
| Hotkey labels | Curated catalog of known names, validated against `GetHotkeyList` | OBS's own localized descriptions, for every hotkey including third-party ones |
| Source hotkeys | Inferred from input kind, plus a runtime audio probe | Reported exactly by the source that registered them |
| Duplicate names | `OBSBasic.SelectScene` and friends are ambiguous — first match wins | Every hotkey individually addressable |
| Source renames | Break the button (targeting is by name) | Survive (targeting is by UUID) |
| Requires | obs-websocket 5.4.0+ for source hotkeys | OBS 30.0+ |

Nothing is unreachable in either mode: anything the curated catalog does not
cover is still listed under "All hotkeys".

The companion talks over the *same* obs-websocket connection using vendor
requests — no second socket, no extra port, no separate authentication. See
[`obs-plugin/README.md`](obs-plugin/README.md) for the protocol and build
instructions.

## Requirements

- Stream Deck 7.1 or later.
- OBS Studio 28 or later, with the WebSocket server enabled
  (*Tools → WebSocket Server Settings*).
- OBS Studio 30.0+ and obs-websocket 5.4.0+ to use source hotkeys.

## Building the Stream Deck plugin

```sh
npm install
npm run build        # bundle to dev.voidscape.obs-extensions.sdPlugin/bin
npm run watch        # rebuild and restart the plugin on change
npm run check        # type check
npm run format       # prettier over src/ and the property inspectors
```

## Continuous integration

Both halves build in CI, and each only runs when its own files change — a
TypeScript-only commit does not spend time on the three-platform OBS matrix.
Tags build everything, since a release needs the full set of artifacts.

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `pull-request.yaml` | Pull requests | Formatting checks, then whichever halves changed. |
| `push.yaml` | `main`, `release/**`, tags | The same, plus a draft release on a version tag. |
| `dispatch.yaml` | Manual | Build either half on demand. |

### Getting a development build

Every run of the Stream Deck job uploads two artifacts:

- **`…-streamdeck-<commit>`** — a `.streamDeckPlugin` file. Download it, unzip,
  and double-click to install; Stream Deck handles the rest.
- **`…-streamdeck-unpacked-<commit>`** — the plugin directory as-is, for
  dropping straight into the Stream Deck plugins folder when a packaged install
  misbehaves.

The OBS companion job uploads per-platform packages (Windows installer and
portable zip, macOS pkg, Ubuntu deb) plus debug symbols, using the standard
[obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate) build
scripts.

### Layout notes

The companion plugin is a subdirectory rather than its own repository, so the
plugintemplate tooling is split to suit: the build scripts live in
`obs-plugin/.github/scripts/` (they resolve the project root as two directories
above themselves, which makes `obs-plugin/` the root), while the composite
actions stay in the repository's own `.github/actions/` and are pointed at the
subdirectory through their `workingDirectory` input.

`obs-plugin/cmake/`, `obs-plugin/.github/scripts/` and `build-aux/` are copied
verbatim from the template and should stay that way so upstream updates apply
cleanly. Only three files diverge, each with a comment saying why.

## Notes

Stream Deck stores plugin global settings as plain JSON on disk, so OBS
WebSocket passwords are held unencrypted. This matches how other OBS-oriented
Stream Deck plugins behave, but it is worth knowing before pointing this at a
remote OBS instance.

Some things are better done with a dedicated request than with a hotkey, and
this plugin deliberately does not route them through one: scene switching
(`SetCurrentProgramScene`) and scene item visibility (`SetSceneItemEnabled`)
are both unambiguous over obs-websocket, whereas their hotkey equivalents are
registered once per scene under a shared name.

## License

GPL-2.0, in full in [`LICENSE`](LICENSE).

The companion plugin links against libobs and vendors `obs-websocket-api.h`,
both of which are GPL-2.0-or-later, so the whole repository is licensed to
match.
