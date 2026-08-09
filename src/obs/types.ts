import type { JsonObject } from "@elgato/utils";

/**
 * A configured OBS WebSocket endpoint.
 *
 * Instances live in the plugin's global settings so that every action can see
 * the same list; individual actions store only the {@link ObsInstance.id}.
 */
export type ObsInstance = {
	/** Stable identifier, generated on creation and never reused. */
	id: string;
	/** Display name shown in the instance dropdowns. */
	name: string;
	host: string;
	port: number;
	/** Empty when the OBS WebSocket server has authentication disabled. */
	password: string;
	/** Whether to connect to this instance on plugin start. */
	autoConnect: boolean;
};

/**
 * Plugin-wide settings.
 *
 * Note that Stream Deck persists global settings as plain JSON on disk, so the
 * passwords here are stored unencrypted. This matches how other OBS-oriented
 * Stream Deck plugins behave, but it is worth being aware of.
 */
export type GlobalSettings = {
	instances?: ObsInstance[];
} & JsonObject;

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** Live state of a single managed connection. */
export type ConnectionState = {
	instanceId: string;
	status: ConnectionStatus;
	/** Populated when {@link ConnectionState.status} is `error`. */
	error?: string;
	/** obs-websocket version reported by the server, e.g. `5.5.0`. */
	obsWebSocketVersion?: string;
	/** OBS Studio version reported by the server, e.g. `30.2.3`. */
	obsVersion?: string;
	/** Whether the companion OBS plugin was detected on this instance. */
	companion: boolean;
};

/** What an action press should do. */
export type TriggerKind = "globalHotkey" | "sourceHotkey" | "filter";

/** What to do to a filter's enabled state. */
export type FilterOperation = "toggle" | "enable" | "disable";

/**
 * Identity of a hotkey, persisted in an action's settings.
 *
 * Deliberately *not* an `obs_hotkey_id`: OBS assigns those from an
 * incrementing counter at registration time, so they change whenever OBS
 * restarts. This composite is resolved to a live hotkey on every press.
 */
export type HotkeyTarget = {
	/** Internal OBS hotkey name, e.g. `libobs.mute`. */
	name: string;
	/** Which kind of object registered the hotkey; companion plugin only. */
	registererType?: "frontend" | "source" | "output" | "encoder" | "service";
	/** Owning source's UUID; survives renames. Companion plugin only. */
	contextUuid?: string;
	/** Owning source's name; used as a fallback and by the heuristic provider. */
	contextName?: string;
	/**
	 * Localized description, used to disambiguate frontend hotkeys that share
	 * a name — every scene registers its own `OBSBasic.SelectScene`.
	 */
	description?: string;
};

/** Settings for the trigger action. */
export type TriggerSettings = {
	instanceId?: string;
	kind?: TriggerKind;

	/** Selected source, for `sourceHotkey` and `filter`. */
	sourceName?: string;
	sourceUuid?: string;

	/** Serialised {@link HotkeyTarget}, for `globalHotkey` and `sourceHotkey`. */
	hotkey?: string;

	/** For `filter`. */
	filterName?: string;
	filterOperation?: FilterOperation;
} & JsonObject;

/** Settings for the connection action. */
export type ConnectionSettings = {
	/** Instance this key connects/disconnects, or empty for "all". */
	instanceId?: string;
	/** Whether pressing the key toggles the connection. */
	pressToToggle?: boolean;
} & JsonObject;

/** An entry in a property inspector dropdown, per the sdpi-components contract. */
export type DataSourceItem = {
	label?: string;
	value: string;
	disabled?: boolean;
};

/** A group of dropdown entries, rendered as an `<optgroup>`. */
export type DataSourceItemGroup = {
	label?: string;
	children: DataSourceItem[];
};

export type DataSourceResult = (DataSourceItem | DataSourceItemGroup)[];
