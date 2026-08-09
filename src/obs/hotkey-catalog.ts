/**
 * Friendly labels for OBS's internal hotkey names.
 *
 * Only used by the heuristic provider, i.e. when the companion OBS plugin is
 * not installed. obs-websocket's `GetHotkeyList` returns bare internal names
 * with no descriptions and no owning context, so this table is the only way to
 * render something readable.
 *
 * Every name here was taken from the OBS source; entries are still validated
 * against the live `GetHotkeyList` response before being offered, so a name
 * that a given OBS build does not register simply never appears. That also
 * makes it safe to list hotkeys from optional plugins.
 */

export type CuratedHotkey = {
	name: string;
	label: string;
};

/**
 * Frontend hotkeys, plus the replay buffer's output hotkey, which users think
 * of as global even though OBS registers it against the output.
 */
export const GLOBAL_HOTKEYS: CuratedHotkey[] = [
	{ name: "OBSBasic.StartStreaming", label: "Start streaming" },
	{ name: "OBSBasic.StopStreaming", label: "Stop streaming" },
	{ name: "OBSBasic.ForceStopStreaming", label: "Force stop streaming" },
	{ name: "OBSBasic.StartRecording", label: "Start recording" },
	{ name: "OBSBasic.StopRecording", label: "Stop recording" },
	{ name: "OBSBasic.PauseRecording", label: "Pause recording" },
	{ name: "OBSBasic.UnpauseRecording", label: "Unpause recording" },
	{ name: "OBSBasic.SplitFile", label: "Split recording file" },
	{ name: "OBSBasic.AddChapterMarker", label: "Add chapter marker" },
	{ name: "OBSBasic.StartReplayBuffer", label: "Start replay buffer" },
	{ name: "OBSBasic.StopReplayBuffer", label: "Stop replay buffer" },
	{ name: "ReplayBuffer.Save", label: "Save replay" },
	{ name: "OBSBasic.StartVirtualCam", label: "Start virtual camera" },
	{ name: "OBSBasic.StopVirtualCam", label: "Stop virtual camera" },
	{ name: "OBSBasic.Transition", label: "Transition (studio mode)" },
	{ name: "OBSBasic.EnablePreviewProgram", label: "Enable studio mode" },
	{ name: "OBSBasic.DisablePreviewProgram", label: "Disable studio mode" },
	{ name: "OBSBasic.TogglePreviewProgram", label: "Toggle studio mode" },
	{ name: "OBSBasic.EnablePreview", label: "Enable preview" },
	{ name: "OBSBasic.DisablePreview", label: "Disable preview" },
	{ name: "OBSBasic.ShowContextBar", label: "Show source toolbar" },
	{ name: "OBSBasic.HideContextBar", label: "Hide source toolbar" },
	{ name: "OBSBasic.Screenshot", label: "Screenshot output" },
	{ name: "OBSBasic.SelectedSourceScreenshot", label: "Screenshot selected source" },
	{ name: "OBSBasic.ResetStats", label: "Reset stats" },
];

/**
 * Hotkeys OBS registers once per scene, all sharing a single name and all
 * registered by the frontend.
 *
 * obs-websocket's `contextName` only disambiguates hotkeys registered by a
 * source, output, encoder or service, so frontend duplicates fall through to
 * "first match wins" — triggering one of these without the companion plugin
 * hits an arbitrary scene. They are offered but marked, and the action steers
 * users towards `SetCurrentProgramScene` instead.
 */
export const AMBIGUOUS_GLOBAL_HOTKEYS = new Set<string>(["OBSBasic.SelectScene"]);

/**
 * Registered by libobs for any input carrying an audio track, regardless of
 * kind. Offered based on a runtime probe rather than a list of input kinds,
 * since plenty of video sources (capture cards, browser sources) carry audio.
 */
export const AUDIO_HOTKEYS: CuratedHotkey[] = [
	{ name: "libobs.mute", label: "Mute" },
	{ name: "libobs.unmute", label: "Unmute" },
	{ name: "libobs.push-to-mute", label: "Push to mute" },
	{ name: "libobs.push-to-talk", label: "Push to talk" },
];

/**
 * Hotkeys registered by specific input kinds, keyed by the unversioned input
 * kind reported by `GetInputList`.
 */
export const HOTKEYS_BY_INPUT_KIND: Record<string, CuratedHotkey[]> = {
	ffmpeg_source: [
		{ name: "MediaSource.Play", label: "Play" },
		{ name: "MediaSource.Pause", label: "Pause" },
		{ name: "MediaSource.Restart", label: "Restart" },
		{ name: "MediaSource.Stop", label: "Stop" },
	],
	vlc_source: [
		{ name: "VLCSource.PlayPause", label: "Play / pause" },
		{ name: "VLCSource.Restart", label: "Restart" },
		{ name: "VLCSource.Stop", label: "Stop" },
		{ name: "VLCSource.PlaylistNext", label: "Next in playlist" },
		{ name: "VLCSource.PlaylistPrev", label: "Previous in playlist" },
	],
	slideshow: [
		{ name: "SlideShow.PlayPause", label: "Play / pause" },
		{ name: "SlideShow.Restart", label: "Restart" },
		{ name: "SlideShow.Stop", label: "Stop" },
		{ name: "SlideShow.NextSlide", label: "Next slide" },
		{ name: "SlideShow.PreviousSlide", label: "Previous slide" },
	],
	browser_source: [{ name: "ObsBrowser.Refresh", label: "Refresh (no cache)" }],
};

// slideshow_v2 replaced slideshow in OBS 30.1 and registers the same hotkeys.
HOTKEYS_BY_INPUT_KIND.slideshow_v2 = HOTKEYS_BY_INPUT_KIND.slideshow;

/**
 * Scene item visibility hotkeys are registered against the owning scene, with
 * the item's name baked into the hotkey name.
 *
 * Note that `SetSceneItemEnabled` is a better way to do this in almost every
 * case; these exist so that a scene's hotkey list is not misleadingly empty.
 */
export function sceneItemHotkeys(sceneItemName: string): CuratedHotkey[] {
	return [
		{ name: `libobs.show_scene_item.${sceneItemName}`, label: `Show "${sceneItemName}"` },
		{ name: `libobs.hide_scene_item.${sceneItemName}`, label: `Hide "${sceneItemName}"` },
	];
}

/** Best-effort friendly label for an arbitrary internal hotkey name. */
export function labelForHotkeyName(name: string): string {
	const known = GLOBAL_HOTKEYS.find((hotkey) => hotkey.name === name);
	if (known) {
		return known.label;
	}

	for (const hotkeys of Object.values(HOTKEYS_BY_INPUT_KIND)) {
		const match = hotkeys.find((hotkey) => hotkey.name === name);
		if (match) {
			return match.label;
		}
	}

	const audio = AUDIO_HOTKEYS.find((hotkey) => hotkey.name === name);
	return audio?.label ?? name;
}
