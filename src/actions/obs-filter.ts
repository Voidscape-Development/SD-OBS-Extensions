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
import { applyFilterOperation, isFilterEnabled } from "../obs/sources";
import type { FilterSettings } from "../obs/types";
import { backfillSourceUuid, filterItems, instanceItems, sourceItems } from "./property-inspector";

/** Key states, in the order the manifest declares them. */
const STATE_OFF = 0;
const STATE_ON = 1;

/**
 * Toggles a filter, and shows whether that filter is currently on.
 *
 * The two states are driven entirely by what OBS reports — the press itself
 * never flips them, and `DisableAutomaticStates` in the manifest stops Stream
 * Deck from flipping them either. A filter switched from inside OBS, from a
 * second key, or by another client therefore lands on the key just the same,
 * and a press that fails leaves the key showing the truth rather than an
 * optimistic guess.
 */
@action({ UUID: "dev.voidscape.obs-extensions.filter" })
export class ObsFilterAction extends SingletonAction<FilterSettings> {
	constructor() {
		super();

		// Keeps keys in step with changes made anywhere else, including in the
		// OBS interface itself.
		connectionManager.on("filterStateChanged", (ev) => {
			void this.#applyToMatching(ev.instanceId, ev.sourceName, ev.filterName, ev.enabled);
		});

		// A reconnect is the one moment the key may have missed events, so
		// re-read rather than trusting what is on screen.
		connectionManager.on("stateChanged", () => void this.#renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<FilterSettings>): Promise<void> {
		await this.#render(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<FilterSettings>): Promise<void> {
		await backfillSourceUuid(ev.action, ev.payload.settings);
		await this.#render(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<FilterSettings>): Promise<void> {
		const { instanceId, sourceName, sourceUuid, filterName } = ev.payload.settings;

		try {
			if (!instanceId) {
				throw new Error("No OBS instance selected for this action.");
			}

			if (!connectionManager.isConnected(instanceId)) {
				throw new Error("Not connected to the selected OBS instance.");
			}

			if (!sourceName || !filterName) {
				throw new Error("This action has no filter selected.");
			}

			const enabled = await applyFilterOperation(
				instanceId,
				{ name: sourceName, uuid: sourceUuid },
				filterName,
				"toggle",
			);

			// The event OBS sends back sets this too; doing it here as well
			// means the key is right immediately on a server that is quiet.
			await this.#setState(ev.action, enabled);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS filter toggle failed: ${message}`);
			await ev.action.showAlert();
		}
	}

	/** Serves the property inspector's dropdowns. */
	override async onSendToPlugin(ev: SendToPluginEvent<{ event: string }, FilterSettings>): Promise<void> {
		const { event } = ev.payload;
		const settings = await ev.action.getSettings();

		switch (event) {
			case "instances":
				await streamDeck.ui.sendToPropertyInspector({ event, items: instanceItems() });
				break;

			case "sources":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await sourceItems(settings) });
				break;

			case "filters":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await filterItems(settings) });
				break;

			case "capabilities":
				await streamDeck.ui.sendToPropertyInspector({
					event,
					connected: Boolean(settings.instanceId) && connectionManager.isConnected(settings.instanceId!),
				});
				break;
		}
	}

	/* --- Filter state ---------------------------------------------------- */

	/** Applies an OBS filter event to every key pointed at that filter. */
	async #applyToMatching(instanceId: string, sourceName: string, filterName: string, enabled: boolean): Promise<void> {
		for (const current of this.actions) {
			const settings = await current.getSettings();
			if (
				settings.instanceId === instanceId &&
				settings.sourceName === sourceName &&
				settings.filterName === filterName
			) {
				await this.#setState(current, enabled);
			}
		}
	}

	async #renderAll(): Promise<void> {
		for (const current of this.actions) {
			await this.#render(current, await current.getSettings());
		}
	}

	/** Reads the filter's live state, so the key is correct as soon as it appears. */
	async #render(
		target: KeyAction<FilterSettings> | DialAction<FilterSettings>,
		settings: FilterSettings,
	): Promise<void> {
		const { instanceId, sourceName, sourceUuid, filterName } = settings;
		if (!instanceId || !sourceName || !filterName || !connectionManager.isConnected(instanceId)) {
			return;
		}

		try {
			await this.#setState(
				target,
				await isFilterEnabled(instanceId, { name: sourceName, uuid: sourceUuid }, filterName),
			);
		} catch {
			// The filter or source may have been removed, or the connection may
			// have dropped mid-read; leave the key showing the last state known
			// to be real rather than misreporting it as off.
		}
	}

	async #setState(target: KeyAction<FilterSettings> | DialAction<FilterSettings>, enabled: boolean): Promise<void> {
		if (target.isKey()) {
			await target.setState(enabled ? STATE_ON : STATE_OFF);
		}
	}
}
