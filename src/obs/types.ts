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
 * The subset of {@link FilterOperation} a trigger action offers.
 *
 * Toggling belongs to the OBS Filter action, which tracks the filter's real
 * state and can show it; a trigger is fire-and-forget, so it only ever drives
 * a filter to a known state.
 */
export type FilterSetOperation = Exclude<FilterOperation, "toggle">;

/** Chosen for a dial interaction that should deliberately do nothing. */
export const NO_ACTION = "none";

/* --- Dials --------------------------------------------------------------- */

/**
 * The dial interactions that can each be given their own action.
 *
 * Stream Deck reports a touchscreen tap separately from a dial press, but the
 * touchscreen sits directly above the dial it belongs to and reads as the same
 * gesture, so a tap runs whatever `press` is set to rather than being
 * configured on its own.
 */
export const DIAL_INTERACTIONS = ["turnLeft", "turnRight", "press"] as const;

export type DialInteraction = (typeof DIAL_INTERACTIONS)[number];

/**
 * A per-interaction copy of every key in `T`, named after the interaction it
 * belongs to: `sourceName` becomes `turnLeftSourceName`, `turnRightSourceName`
 * and `pressSourceName`.
 *
 * Flat rather than nested because each control in a property inspector binds
 * to one settings key by name, and sdpi-components has no notion of a path.
 */
export type PerInteraction<T> = {
	[K in keyof T & string as `${DialInteraction}${Capitalize<K>}`]?: T[K];
};

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

/**
 * An instance, and the source on it that one press or one dial interaction is
 * pointed at.
 *
 * The property inspector stores the source by name, since that is what its
 * dropdown shows; the UUID is resolved alongside it so requests can target the
 * source by UUID and survive a later rename in OBS.
 */
export type SourceScope = {
	instanceId?: string;
	sourceName?: string;
	sourceUuid?: string;
};

/** Settings shared by every action that targets a source. */
export type SourceScopedSettings = SourceScope & JsonObject;

/**
 * What one press, or one dial interaction, does in the trigger action.
 *
 * A key stores exactly one of these, unprefixed; a dial stores one per
 * interaction. Keeping the two in the same shape means a key's settings are
 * still read the way they always were, and the execution path is shared.
 */
export type TriggerAssignment = {
	/** `none` on a dial interaction that is deliberately left unassigned. */
	kind?: TriggerKind | typeof NO_ACTION;

	sourceName?: string;
	sourceUuid?: string;

	/** Serialised {@link HotkeyTarget}, for `globalHotkey` and `sourceHotkey`. */
	hotkey?: string;

	/** For `filter`. */
	filterName?: string;
	filterOperation?: FilterSetOperation;
};

/** Settings for the trigger action. */
export type TriggerSettings = TriggerAssignment & PerInteraction<TriggerAssignment> & SourceScopedSettings;

/** What one dial interaction does in the filter action. */
export type FilterAssignment = {
	sourceName?: string;
	sourceUuid?: string;
	filterName?: string;
	/** Absent on a key, which always toggles. */
	filterOperation?: FilterOperation | typeof NO_ACTION;
};

/** Settings for the filter action. */
export type FilterSettings = {
	filterName?: string;

	/**
	 * Which interaction's filter the dial's touchscreen reports on. Every
	 * interaction may point at a different filter, but the display can only
	 * follow one of them.
	 */
	feedbackInteraction?: DialInteraction;
} & PerInteraction<FilterAssignment> &
	SourceScopedSettings;

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
