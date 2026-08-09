# OBS Extensions — companion plugin

An optional native OBS Studio plugin that makes the Stream Deck plugin's hotkey
support exact instead of approximate. It adds nothing to the OBS interface.

## Why it exists

obs-websocket's `GetHotkeyList` returns a flat array of bare internal hotkey
names — no descriptions, no owning context, and no de-duplication. In practice
that means:

- Every audio source contributes an identical `libobs.mute` entry, and nothing
  in the response says which source each belongs to.
- Names are internal identifiers (`libobs.push-to-mute`, `OBSBasic.SelectScene`)
  rather than the localized labels OBS shows in its own hotkey settings.
- `TriggerHotkeyByName` disambiguates only by *name*, so a renamed source breaks
  the target, and frontend-registered duplicates (one `OBSBasic.SelectScene` per
  scene) cannot be told apart at all.

Running in-process, this plugin can call `obs_enum_hotkeys()` and read each
hotkey's localized description, its stable identity, and the source, output,
encoder, or service that registered it — including that source's UUID.

Without it, the Stream Deck plugin still works; it falls back to a curated
catalog of well-known hotkey names filtered against `GetHotkeyList`. With it,
the hotkey dropdowns show real labels, every entry is individually addressable,
and buttons survive source renames.

## How it connects

There is no second socket and no extra port. The plugin registers an
[obs-websocket vendor](https://github.com/obsproject/obs-websocket/blob/master/lib/obs-websocket-api.h)
named `dev.voidscape.obs-extensions`, and the Stream Deck plugin reaches it with
ordinary `CallVendorRequest` calls over the connection it already holds — same
authentication, same port. If the plugin is not installed, that request fails
and the Stream Deck plugin quietly falls back.

The wire contract is documented in [`src/vendor-protocol.h`](src/vendor-protocol.h),
mirrored on the TypeScript side in `src/obs/vendor-protocol.ts`.

| Request | Purpose |
| --- | --- |
| `GetVersion` | Capability probe; returns the protocol version. |
| `GetHotkeys` | Full hotkey inventory with descriptions and resolved context. |
| `TriggerHotkey` | Resolves a stable composite key to a live hotkey and fires it. |

### A note on hotkey IDs

`obs_hotkey_id` is handed out by an incrementing counter at registration time.
It is not persisted and is not stable across OBS restarts, or across a source
being removed and re-added. `GetHotkeys` reports the id for the current session,
but clients must never store it. Instead store the composite of
`name` + `registererType` + `contextUuid` + `description` and let
`TriggerHotkey` resolve it to a live id on each press.

`TriggerHotkey` resolves in two passes: the first honours `contextUuid`, and if
nothing matches it retries against `contextName`, so a source that was deleted
and re-created under the same name keeps working.

## Requirements

- OBS Studio 30.0 or later (source UUIDs were added in 30.0).
- obs-websocket 5.x, bundled with OBS since 28.0.
- The OBS development headers, via a full OBS source build or the OBS SDK.

## Building

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/path/to/obs-studio/build
cmake --build build --config Release
```

`CMAKE_PREFIX_PATH` needs to point at wherever libobs' CMake package config
lives; omit it if libobs is already on the default search path.

## Installing

`cmake --install build` covers a system-wide install. During development the
per-user plugin directories are usually easier — copy the built module and the
`data/` directory to:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\obs-studio\plugins\obs-extensions\bin\64bit\` (data in `...\obs-extensions\data\`) |
| macOS | `~/Library/Application Support/obs-studio/plugins/obs-extensions.plugin` |
| Linux | `~/.config/obs-studio/plugins/obs-extensions/bin/64bit/` (data in `.../obs-extensions/data/`) |

Restart OBS afterwards. The OBS log should contain:

```
[obs-extensions] Registered obs-websocket vendor 'dev.voidscape.obs-extensions' (protocol version 1).
```

If you instead see a warning about obs-websocket not being available, the
WebSocket server plugin is missing or disabled.

## Third-party code

`vendor/obs-websocket-api.h` is copied verbatim from
[obs-websocket](https://github.com/obsproject/obs-websocket) (GPL-2.0-or-later).
It is header-only and reaches obs-websocket through the OBS proc handler, so
there is no build-time or link-time dependency on obs-websocket itself.
