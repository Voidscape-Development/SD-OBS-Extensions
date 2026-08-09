import streamDeck from "@elgato/streamdeck";
import OBSWebSocket from "obs-websocket-js/json";
import type { OBSRequestTypes, OBSResponseTypes } from "obs-websocket-js";

import type { ConnectionState, GlobalSettings, ObsInstance } from "./types";
import { SUPPORTED_PROTOCOL_VERSION, VENDOR_NAME, VendorRequest, type GetVersionResponse } from "./vendor-protocol";

/** Reconnect backoff, in milliseconds. */
const RECONNECT_BASE_DELAY = 2_000;
const RECONNECT_MAX_DELAY = 30_000;

/**
 * obs-websocket 5.4.0 added both `contextName` on `TriggerHotkeyByName` and
 * UUID targeting for sources and filters.
 *
 * Older servers silently ignore `contextName`, which would fire some other
 * source's hotkey, so the heuristic provider declines to offer source hotkeys
 * below this version. UUID targeting simply falls back to targeting by name.
 */
const MIN_VERSION_FOR_UUID_AND_CONTEXT = [5, 4, 0] as const;

type Events = {
	/** A connection changed status, or its capabilities were re-detected. */
	stateChanged: (state: ConnectionState) => void;
	/** The configured instance list changed. */
	instancesChanged: (instances: ObsInstance[]) => void;
	/** A filter's enabled state changed in OBS. */
	filterStateChanged: (event: { instanceId: string; sourceName: string; filterName: string; enabled: boolean }) => void;
};

/** Compares dotted version strings, tolerating suffixes such as `5.5.0-beta1`. */
function isVersionAtLeast(version: string | undefined, minimum: readonly number[]): boolean {
	if (!version) {
		return false;
	}

	const parts = version.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < minimum.length; i++) {
		const part = parts[i] ?? 0;
		if (Number.isNaN(part)) {
			return false;
		}
		if (part !== minimum[i]) {
			return part > minimum[i];
		}
	}

	return true;
}

/** A single OBS endpoint and everything we track about it. */
class ManagedConnection {
	public readonly obs = new OBSWebSocket();

	/** Whether this connection *should* be up; drives reconnection. */
	public desired = false;
	public status: ConnectionState["status"] = "disconnected";
	public error?: string;
	public obsWebSocketVersion?: string;
	public obsVersion?: string;
	public companion = false;

	#reconnectTimer?: NodeJS.Timeout;
	#reconnectAttempts = 0;

	constructor(public instance: ObsInstance) {}

	public get url(): string {
		return `ws://${this.instance.host}:${this.instance.port}`;
	}

	/**
	 * True when the server is new enough for `TriggerHotkeyByName` to honour
	 * `contextName` and for requests to accept UUIDs.
	 */
	public get supportsUuidAndContext(): boolean {
		return isVersionAtLeast(this.obsWebSocketVersion, MIN_VERSION_FOR_UUID_AND_CONTEXT);
	}

	public scheduleReconnect(run: () => void): void {
		this.clearReconnect();

		const delay = Math.min(RECONNECT_BASE_DELAY * 2 ** this.#reconnectAttempts, RECONNECT_MAX_DELAY);
		this.#reconnectAttempts++;
		this.#reconnectTimer = setTimeout(run, delay);
	}

	public clearReconnect(): void {
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
	}

	public resetBackoff(): void {
		this.#reconnectAttempts = 0;
	}
}

/**
 * Owns every OBS WebSocket connection the plugin holds.
 *
 * The configured instance list lives in the plugin's global settings, so this
 * manager is the single place that reconciles that list against the live
 * sockets — adding, dropping, and reconnecting as the user edits them.
 */
export class ConnectionManager {
	readonly #connections = new Map<string, ManagedConnection>();
	readonly #listeners: { [K in keyof Events]: Events[K][] } = {
		stateChanged: [],
		instancesChanged: [],
		filterStateChanged: [],
	};

	/**
	 * Loads the configured instances and brings up everything marked for
	 * auto-connect. Also watches global settings so edits made in a property
	 * inspector take effect immediately.
	 */
	public async initialize(): Promise<void> {
		streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
			void this.#sync(ev.settings.instances ?? []);
		});

		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		await this.#sync(settings.instances ?? []);
	}

	public on<K extends keyof Events>(event: K, listener: Events[K]): void {
		this.#listeners[event].push(listener);
	}

	public getInstances(): ObsInstance[] {
		return [...this.#connections.values()]
			.map((connection) => connection.instance)
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
	}

	public getInstance(instanceId: string): ObsInstance | undefined {
		return this.#connections.get(instanceId)?.instance;
	}

	public getState(instanceId: string): ConnectionState | undefined {
		const connection = this.#connections.get(instanceId);
		return connection ? this.#stateOf(connection) : undefined;
	}

	public getStates(): ConnectionState[] {
		return [...this.#connections.values()].map((connection) => this.#stateOf(connection));
	}

	public isConnected(instanceId: string): boolean {
		return this.#connections.get(instanceId)?.status === "connected";
	}

	/** Whether the companion OBS plugin was detected on this instance. */
	public hasCompanion(instanceId: string): boolean {
		return this.#connections.get(instanceId)?.companion === true;
	}

	/** Whether `TriggerHotkeyByName` on this instance honours `contextName`. */
	public supportsHotkeyContext(instanceId: string): boolean {
		return this.#connections.get(instanceId)?.supportsUuidAndContext === true;
	}

	/** Whether requests on this instance accept `sourceUuid` and friends. */
	public supportsUuids(instanceId: string): boolean {
		return this.#connections.get(instanceId)?.supportsUuidAndContext === true;
	}

	/** Persists the instance list and reconciles the live connections. */
	public async saveInstances(instances: ObsInstance[]): Promise<void> {
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		await streamDeck.settings.setGlobalSettings({ ...settings, instances });
		await this.#sync(instances);
	}

	public async connect(instanceId: string): Promise<void> {
		const connection = this.#connections.get(instanceId);
		if (!connection) {
			throw new Error(`No OBS instance is configured with id '${instanceId}'.`);
		}

		connection.desired = true;
		await this.#open(connection);
	}

	public async disconnect(instanceId: string): Promise<void> {
		const connection = this.#connections.get(instanceId);
		if (!connection) {
			return;
		}

		connection.desired = false;
		connection.clearReconnect();
		await connection.obs.disconnect().catch(() => undefined);

		this.#setStatus(connection, "disconnected");
	}

	public async toggle(instanceId: string): Promise<void> {
		if (this.isConnected(instanceId)) {
			await this.disconnect(instanceId);
		} else {
			await this.connect(instanceId);
		}
	}

	/** Issues an obs-websocket request, throwing when the instance is down. */
	public async call<T extends keyof OBSRequestTypes>(
		instanceId: string,
		requestType: T,
		requestData?: OBSRequestTypes[T],
	): Promise<OBSResponseTypes[T]> {
		const connection = this.#connections.get(instanceId);
		if (!connection) {
			throw new Error("The OBS instance for this action no longer exists. Pick one in the action's settings.");
		}

		if (connection.status !== "connected") {
			throw new Error(`Not connected to '${connection.instance.name}'.`);
		}

		return connection.obs.call(requestType, requestData);
	}

	/**
	 * Calls a request on the companion OBS plugin.
	 *
	 * Throws when the companion is not installed, which callers use to fall
	 * back to plain obs-websocket requests.
	 */
	public async callVendor<T>(instanceId: string, requestType: string, requestData?: object): Promise<T> {
		const { responseData } = await this.call(instanceId, "CallVendorRequest", {
			vendorName: VENDOR_NAME,
			requestType,
			requestData: (requestData ?? {}) as Record<string, never>,
		});

		const response = responseData as T & { success?: boolean; error?: string };
		if (response?.success === false) {
			throw new Error(response.error ?? `Companion request '${requestType}' failed.`);
		}

		return response;
	}

	/** Reconciles the live connections against a newly saved instance list. */
	async #sync(instances: ObsInstance[]): Promise<void> {
		const seen = new Set<string>();

		for (const instance of instances) {
			seen.add(instance.id);

			const existing = this.#connections.get(instance.id);
			if (!existing) {
				const connection = new ManagedConnection(instance);
				this.#connections.set(instance.id, connection);
				this.#attachListeners(connection);

				if (instance.autoConnect) {
					connection.desired = true;
					void this.#open(connection);
				}

				continue;
			}

			// Reconnect when the endpoint itself changed; a rename is cosmetic.
			const endpointChanged =
				existing.instance.host !== instance.host ||
				existing.instance.port !== instance.port ||
				existing.instance.password !== instance.password;

			existing.instance = instance;

			if (endpointChanged && existing.desired) {
				await existing.obs.disconnect().catch(() => undefined);
				void this.#open(existing);
			}
		}

		for (const [id, connection] of this.#connections) {
			if (!seen.has(id)) {
				connection.desired = false;
				connection.clearReconnect();
				await connection.obs.disconnect().catch(() => undefined);
				this.#connections.delete(id);
			}
		}

		this.#emit("instancesChanged", this.getInstances());
	}

	#attachListeners(connection: ManagedConnection): void {
		connection.obs.on("ConnectionClosed", () => {
			if (connection.status === "disconnected" && !connection.desired) {
				return;
			}

			this.#setStatus(connection, connection.desired ? "connecting" : "disconnected");

			if (connection.desired) {
				connection.scheduleReconnect(() => void this.#open(connection));
			}
		});

		// Surfaced separately from ConnectionClosed so the reason isn't lost.
		connection.obs.on("ConnectionError", (err) => {
			connection.error = err.message;
			streamDeck.logger.warn(`OBS '${connection.instance.name}' connection error: ${err.message}`);
		});

		connection.obs.on("SourceFilterEnableStateChanged", (ev) => {
			this.#emit("filterStateChanged", {
				instanceId: connection.instance.id,
				sourceName: ev.sourceName,
				filterName: ev.filterName,
				enabled: ev.filterEnabled,
			});
		});
	}

	async #open(connection: ManagedConnection): Promise<void> {
		connection.clearReconnect();

		if (connection.status === "connected") {
			return;
		}

		this.#setStatus(connection, "connecting");

		try {
			const { obsWebSocketVersion } = await connection.obs.connect(
				connection.url,
				connection.instance.password || undefined,
				{ rpcVersion: 1 },
			);

			connection.obsWebSocketVersion = obsWebSocketVersion;
			connection.resetBackoff();

			await this.#detectCapabilities(connection);
			this.#setStatus(connection, "connected");

			streamDeck.logger.info(
				`Connected to OBS '${connection.instance.name}' (obs-websocket ${obsWebSocketVersion}` +
					`${connection.companion ? ", companion plugin detected" : ""}).`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			connection.error = message;
			this.#setStatus(connection, "error");

			if (connection.desired) {
				connection.scheduleReconnect(() => void this.#open(connection));
			}
		}
	}

	/** Records the OBS version and probes for the companion plugin. */
	async #detectCapabilities(connection: ManagedConnection): Promise<void> {
		try {
			const version = await connection.obs.call("GetVersion");
			connection.obsVersion = version.obsVersion;
			connection.obsWebSocketVersion = version.obsWebSocketVersion;
		} catch {
			// Non-fatal; version gating just falls back to the safe path.
		}

		connection.companion = false;

		try {
			const { responseData } = await connection.obs.call("CallVendorRequest", {
				vendorName: VENDOR_NAME,
				requestType: VendorRequest.getVersion,
				requestData: {} as Record<string, never>,
			});

			const response = responseData as GetVersionResponse;
			const protocolVersion = response?.protocolVersion ?? 0;

			if (response?.success === false) {
				return;
			}

			if (protocolVersion > SUPPORTED_PROTOCOL_VERSION) {
				streamDeck.logger.warn(
					`OBS '${connection.instance.name}' has companion protocol v${protocolVersion}, but this ` +
						`plugin only understands v${SUPPORTED_PROTOCOL_VERSION}. Update the Stream Deck plugin. ` +
						`Falling back to standard obs-websocket requests.`,
				);
				return;
			}

			connection.companion = protocolVersion >= 1;
		} catch {
			// No companion plugin installed; the heuristic provider takes over.
		}
	}

	#stateOf(connection: ManagedConnection): ConnectionState {
		return {
			instanceId: connection.instance.id,
			status: connection.status,
			error: connection.status === "error" ? connection.error : undefined,
			obsWebSocketVersion: connection.obsWebSocketVersion,
			obsVersion: connection.obsVersion,
			companion: connection.companion,
		};
	}

	#setStatus(connection: ManagedConnection, status: ConnectionState["status"]): void {
		if (connection.status === status) {
			return;
		}

		connection.status = status;
		if (status === "connected" || status === "disconnected") {
			connection.error = undefined;
		}

		this.#emit("stateChanged", this.#stateOf(connection));
	}

	#emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
		for (const listener of this.#listeners[event]) {
			try {
				(listener as (...a: Parameters<Events[K]>) => void)(...args);
			} catch (err) {
				streamDeck.logger.error(`Listener for '${event}' threw.`, err);
			}
		}
	}
}

/** Shared across every action in the plugin. */
export const connectionManager = new ConnectionManager();
