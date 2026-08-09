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

Connections are held open with automatic reconnection and exponential backoff,
so pressing a trigger key fires immediately rather than paying for a handshake.

### OBS Trigger

One key, three things it can do against a chosen instance:

- **Global hotkey** — OBS's frontend hotkeys (start/stop streaming, recording,
  replay buffer, virtual camera, studio mode, screenshots, and so on).
- **Source hotkey** — hotkeys belonging to a specific source, picked from an
  alphabetical source list: mute/unmute and push-to-talk on audio sources,
  play/pause/restart on media and VLC sources, refresh on browser sources.
- **Filter** — enable, disable, or toggle a filter on any source or scene.

Filter keys track their filter's real state through obs-websocket events, so
they stay correct even when the filter is changed from inside OBS.

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
npm run build     # bundle to dev.voidscape.obs-extensions.sdPlugin/bin
npm run watch     # rebuild and restart the plugin on change
```

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
