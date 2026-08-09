/**
 * TypeScript mirror of the companion OBS plugin's vendor contract.
 *
 * The authoritative definition lives in `obs-plugin/src/vendor-protocol.h`;
 * keep the two in sync.
 */

/** Vendor name the companion plugin registers with obs-websocket. */
export const VENDOR_NAME = "dev.voidscape.obs-extensions";

/**
 * Highest contract version this client understands. A companion reporting a
 * higher major version is treated as unavailable, and the plugin falls back to
 * plain obs-websocket requests rather than guessing at a newer shape.
 */
export const SUPPORTED_PROTOCOL_VERSION = 1;

export const VendorRequest = {
	getVersion: "GetVersion",
	getHotkeys: "GetHotkeys",
	triggerHotkey: "TriggerHotkey",
} as const;

/**
 * obs-websocket has no status channel for vendor requests, so the companion
 * reports failures inside the response body instead.
 */
type VendorResponse = {
	success?: boolean;
	error?: string;
};

export type GetVersionResponse = VendorResponse & {
	protocolVersion?: number;
	pluginVersion?: string;
};

/**
 * A single hotkey as reported by the companion plugin.
 *
 * `id` is only meaningful for the current OBS session and must never be
 * persisted — see the note in `obs-plugin/README.md`.
 */
export type VendorHotkey = {
	id: number;
	name: string;
	description?: string;
	registererType?: "frontend" | "source" | "output" | "encoder" | "service";
	/** Absent for frontend hotkeys. */
	contextName?: string;
	/** Only present for source-registered hotkeys. */
	contextUuid?: string;
	/** Unversioned source kind, matching obs-websocket's `inputKind`. */
	contextKind?: string;
};

export type GetHotkeysResponse = VendorResponse & {
	hotkeys?: VendorHotkey[];
};

export type TriggerHotkeyResponse = VendorResponse & {
	hotkeyId?: number;
	/** How many hotkeys satisfied the criteria; above one means ambiguous. */
	matches?: number;
	matchedBy?: "uuid" | "name";
};
