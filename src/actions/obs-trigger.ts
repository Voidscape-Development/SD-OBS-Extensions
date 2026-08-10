import streamDeck, {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";

import { connectionManager } from "../obs/connection-manager";
import { getHotkeyProvider, type HotkeyChoice } from "../obs/hotkey-provider";
import { applyFilterOperation, findSource } from "../obs/sources";
import type { DataSourceItem, DataSourceResult, FilterSetOperation, HotkeyTarget, TriggerSettings } from "../obs/types";
import { backfillSourceUuid, filterItems, instanceItems, notice, sourceItems } from "./property-inspector";

function parseHotkey(serialised: string | undefined): HotkeyTarget | undefined {
	if (!serialised) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(serialised) as HotkeyTarget;
		return parsed?.name ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Settings written before the OBS Filter action existed may still say
 * `toggle`, which this action no longer offers. Enabling is the closest
 * single-shot reading of it, and the property inspector shows the correction
 * the next time the key is opened.
 */
function toSetOperation(operation: string | undefined): FilterSetOperation {
	return operation === "disable" ? "disable" : "enable";
}

/**
 * Fires an OBS hotkey, or drives a filter to a known state, when the key is
 * pressed.
 *
 * A single state throughout: a trigger has no idea what the hotkey it fired
 * did inside OBS, so there is nothing honest for a second state to show. Live
 * on/off feedback for filters is the OBS Filter action's job.
 *
 * Everything the property inspector shows is fetched live from OBS, so the
 * dropdowns always reflect the instance the action is pointed at.
 */
@action({ UUID: "dev.voidscape.obs-extensions.trigger" })
export class ObsTriggerAction extends SingletonAction<TriggerSettings> {
	override async onWillAppear(ev: WillAppearEvent<TriggerSettings>): Promise<void> {
		await backfillSourceUuid(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TriggerSettings>): Promise<void> {
		await backfillSourceUuid(ev.action, ev.payload.settings);
	}

	override async onKeyDown(ev: KeyDownEvent<TriggerSettings>): Promise<void> {
		try {
			await this.#execute(ev.payload.settings);
			await ev.action.showOk();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS trigger failed: ${message}`);
			await ev.action.showAlert();
		}
	}

	async #execute(settings: TriggerSettings): Promise<void> {
		const { instanceId, kind } = settings;

		if (!instanceId) {
			throw new Error("No OBS instance selected for this action.");
		}

		if (!connectionManager.isConnected(instanceId)) {
			throw new Error("Not connected to the selected OBS instance.");
		}

		if (kind === "filter") {
			if (!settings.sourceName || !settings.filterName) {
				throw new Error("This action has no filter selected.");
			}

			await applyFilterOperation(
				instanceId,
				{ name: settings.sourceName, uuid: settings.sourceUuid },
				settings.filterName,
				toSetOperation(settings.filterOperation),
			);

			return;
		}

		const hotkey = parseHotkey(settings.hotkey);
		if (!hotkey) {
			throw new Error("This action has no hotkey selected.");
		}

		await getHotkeyProvider(instanceId).trigger(hotkey);
	}

	/** Serves every dropdown in the property inspector. */
	override async onSendToPlugin(ev: SendToPluginEvent<{ event: string }, TriggerSettings>): Promise<void> {
		const { event } = ev.payload;
		const settings = await ev.action.getSettings();

		switch (event) {
			case "instances":
				await streamDeck.ui.sendToPropertyInspector({ event, items: instanceItems() });
				break;

			case "sources":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await sourceItems(settings) });
				break;

			case "hotkeys":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await this.#hotkeyItems(settings) });
				break;

			case "filters":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await filterItems(settings) });
				break;

			case "capabilities":
				await streamDeck.ui.sendToPropertyInspector({ event, ...this.#capabilities(settings) });
				break;
		}
	}

	/**
	 * Tells the property inspector which hotkey backend is in play, so it can
	 * explain the difference rather than silently offering a worse list.
	 */
	#capabilities(settings: TriggerSettings): {
		connected: boolean;
		companion: boolean;
		supportsHotkeyContext: boolean;
	} {
		const { instanceId } = settings;

		return {
			connected: Boolean(instanceId) && connectionManager.isConnected(instanceId!),
			companion: Boolean(instanceId) && connectionManager.hasCompanion(instanceId!),
			supportsHotkeyContext: Boolean(instanceId) && connectionManager.supportsHotkeyContext(instanceId!),
		};
	}

	async #hotkeyItems(settings: TriggerSettings): Promise<DataSourceResult> {
		const { instanceId, kind } = settings;
		if (!instanceId || !connectionManager.isConnected(instanceId)) {
			return notice("Connect to an OBS instance first");
		}

		const provider = getHotkeyProvider(instanceId);

		try {
			let choices: HotkeyChoice[];

			if (kind === "sourceHotkey") {
				if (!settings.sourceName) {
					return notice("Select a source first");
				}

				const source = await findSource(instanceId, settings.sourceName);
				if (!source) {
					return notice("That source no longer exists");
				}

				choices = await provider.listSourceHotkeys(source);

				if (choices.length === 0 && !connectionManager.supportsHotkeyContext(instanceId)) {
					return notice("Requires obs-websocket 5.4.0 or later");
				}
			} else {
				choices = await provider.listGlobalHotkeys();
			}

			if (choices.length === 0) {
				return notice("No hotkeys found");
			}

			return this.#groupChoices(choices);
		} catch (err) {
			streamDeck.logger.error("Failed to list OBS hotkeys.", err);
			return notice("Could not load hotkeys");
		}
	}

	/** Preserves the provider's grouping, and flags ambiguous entries. */
	#groupChoices(choices: HotkeyChoice[]): DataSourceResult {
		const toItem = (choice: HotkeyChoice): DataSourceItem => ({
			label: choice.ambiguous ? `${choice.label} (ambiguous)` : choice.label,
			value: JSON.stringify(choice.target),
		});

		const groups = new Map<string, DataSourceItem[]>();
		const ungrouped: DataSourceItem[] = [];

		for (const choice of choices) {
			if (!choice.group) {
				ungrouped.push(toItem(choice));
				continue;
			}

			const existing = groups.get(choice.group);
			if (existing) {
				existing.push(toItem(choice));
			} else {
				groups.set(choice.group, [toItem(choice)]);
			}
		}

		if (groups.size === 0) {
			return ungrouped;
		}

		return [...ungrouped, ...[...groups.entries()].map(([label, children]) => ({ label, children }))];
	}
}
