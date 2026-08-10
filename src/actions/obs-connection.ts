import streamDeck, {
	action,
	SingletonAction,
	type DialAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";

import { connectionManager } from "../obs/connection-manager";
import type { ConnectionSettings, DataSourceItem, ObsInstance } from "../obs/types";

/** Sentinel used by the "all instances" dropdown entry. */
const ALL_INSTANCES = "";

/**
 * Key artwork, swapped on the action's single state.
 *
 * The action deliberately has one state rather than two. A second state is
 * Stream Deck's to flip as well as ours — it advances on every press, whether
 * or not the connection actually came up — which is how a key ended up showing
 * "connected" for an instance that was not, and it splits title styling across
 * two appearances that have to be configured separately. With one state, what
 * the key shows is a pure function of what the connection manager reports.
 *
 * The @2x artwork is used so the image is crisp on every device; Stream Deck
 * scales it down for smaller keys.
 */
const IMAGE_CONNECTED = "imgs/actions/connection/key-active@2x.png";
const IMAGE_IDLE = "imgs/actions/connection/key@2x.png";

const DEFAULT_INSTANCE: Omit<ObsInstance, "id"> = {
	name: "OBS",
	host: "127.0.0.1",
	port: 4455,
	password: "",
	autoConnect: true,
};

type InstancePayload = {
	event: string;
	instance?: ObsInstance;
	instanceId?: string;
};

/**
 * Manages the plugin's OBS instances, and doubles as a connect/disconnect key.
 *
 * Stream Deck has no plugin-level settings screen, so this action's property
 * inspector is where the shared instance list is edited; every other action
 * simply picks from it.
 *
 * The key shows connection status through its image and title, both re-derived
 * from the connection manager on every change — see {@link IMAGE_CONNECTED}.
 */
@action({ UUID: "dev.voidscape.obs-extensions.connection" })
export class ObsConnectionAction extends SingletonAction<ConnectionSettings> {
	constructor() {
		super();

		connectionManager.on("stateChanged", () => void this.#renderAll());
		connectionManager.on("instancesChanged", () => void this.#renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<ConnectionSettings>): Promise<void> {
		await this.#render(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ConnectionSettings>): Promise<void> {
		await this.#render(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<ConnectionSettings>): Promise<void> {
		const { instanceId, pressToToggle } = ev.payload.settings;

		try {
			const targets =
				instanceId && instanceId !== ALL_INSTANCES
					? [instanceId]
					: connectionManager.getInstances().map((instance) => instance.id);

			if (targets.length === 0) {
				throw new Error("No OBS instances are configured.");
			}

			for (const target of targets) {
				if (pressToToggle === false) {
					await connectionManager.connect(target);
				} else {
					await connectionManager.toggle(target);
				}
			}

			await ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error("Connection action failed.", err);
			await ev.action.showAlert();
		}

		await this.#render(ev.action, ev.payload.settings);
	}

	/**
	 * Serves the property inspector: the instance dropdown, plus the CRUD
	 * operations behind the instance editor.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<InstancePayload, ConnectionSettings>): Promise<void> {
		const { event } = ev.payload;

		switch (event) {
			case "instances":
				await streamDeck.ui.sendToPropertyInspector({
					event,
					items: this.#instanceItems(true),
				});
				break;

			case "instanceList":
				await streamDeck.ui.sendToPropertyInspector({
					event,
					items: this.#instanceItems(false),
				});
				break;

			case "getInstance": {
				const instance = ev.payload.instanceId ? connectionManager.getInstance(ev.payload.instanceId) : undefined;
				const state = ev.payload.instanceId ? connectionManager.getState(ev.payload.instanceId) : undefined;

				await streamDeck.ui.sendToPropertyInspector({
					event,
					instance: instance ?? { id: "", ...DEFAULT_INSTANCE },
					status: state?.status ?? "disconnected",
					error: state?.error ?? "",
					companion: state?.companion ?? false,
					obsVersion: state?.obsVersion ?? "",
					obsWebSocketVersion: state?.obsWebSocketVersion ?? "",
				});
				break;
			}

			case "saveInstance": {
				const incoming = ev.payload.instance;
				if (!incoming) {
					break;
				}

				const instances = connectionManager.getInstances();
				const id = incoming.id || globalThis.crypto.randomUUID();
				const record: ObsInstance = { ...incoming, id, port: Number(incoming.port) || 4455 };

				const index = instances.findIndex((instance) => instance.id === id);
				if (index >= 0) {
					instances[index] = record;
				} else {
					instances.push(record);
				}

				await connectionManager.saveInstances(instances);
				await streamDeck.ui.sendToPropertyInspector({ event, instanceId: id });
				break;
			}

			case "deleteInstance": {
				const remaining = connectionManager.getInstances().filter((instance) => instance.id !== ev.payload.instanceId);

				await connectionManager.saveInstances(remaining);
				await streamDeck.ui.sendToPropertyInspector({ event, ok: true });
				break;
			}

			case "toggleInstance": {
				let error = "";
				try {
					if (ev.payload.instanceId) {
						await connectionManager.toggle(ev.payload.instanceId);
					}
				} catch (err) {
					error = err instanceof Error ? err.message : String(err);
				}

				const state = ev.payload.instanceId ? connectionManager.getState(ev.payload.instanceId) : undefined;
				await streamDeck.ui.sendToPropertyInspector({
					event,
					status: state?.status ?? "disconnected",
					error: error || state?.error || "",
				});
				break;
			}
		}
	}

	#instanceItems(includeAll: boolean): DataSourceItem[] {
		const items: DataSourceItem[] = connectionManager.getInstances().map((instance) => ({
			label: instance.name,
			value: instance.id,
		}));

		if (includeAll) {
			items.unshift({ label: "All instances", value: ALL_INSTANCES });
		}

		return items;
	}

	async #renderAll(): Promise<void> {
		for (const current of this.actions) {
			const settings = await current.getSettings();
			await this.#render(current, settings);
		}
	}

	/**
	 * Shows the instance name over its status. Keys default to no title, so an
	 * unconfigured action reads as "no instances" rather than looking broken.
	 *
	 * Both the title and the image come from the connection manager every time,
	 * so a key can only ever be as stale as the last event it was told about,
	 * and re-rendering is always safe.
	 */
	async #render(
		target: KeyAction<ConnectionSettings> | DialAction<ConnectionSettings>,
		settings: ConnectionSettings,
	): Promise<void> {
		const { instanceId } = settings;

		if (!instanceId || instanceId === ALL_INSTANCES) {
			const states = connectionManager.getStates();
			const connected = states.filter((state) => state.status === "connected").length;

			await target.setTitle(states.length === 0 ? "No OBS\ninstances" : `OBS\n${connected}/${states.length}`);
			await this.#setImage(target, connected > 0 && connected === states.length);

			return;
		}

		const instance = connectionManager.getInstance(instanceId);
		const state = connectionManager.getState(instanceId);

		if (!instance || !state) {
			await target.setTitle("Missing\ninstance");
			await this.#setImage(target, false);

			return;
		}

		const statusLabel = {
			connected: "Connected",
			connecting: "Connecting",
			disconnected: "Offline",
			error: "Error",
		}[state.status];

		await target.setTitle(`${instance.name}\n${statusLabel}`);
		await this.#setImage(target, state.status === "connected");
	}

	async #setImage(
		target: KeyAction<ConnectionSettings> | DialAction<ConnectionSettings>,
		connected: boolean,
	): Promise<void> {
		if (target.isKey()) {
			await target.setImage(connected ? IMAGE_CONNECTED : IMAGE_IDLE);
		}
	}
}
