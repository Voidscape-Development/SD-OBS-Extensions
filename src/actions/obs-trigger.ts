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
import { getHotkeyProvider, type HotkeyChoice } from "../obs/hotkey-provider";
import { applyFilterOperation, findSource, isFilterEnabled, listFilters, listSources } from "../obs/sources";
import type { DataSourceItem, DataSourceResult, HotkeyTarget, TriggerSettings } from "../obs/types";

/** Shown in place of a dropdown's contents when it cannot be populated. */
function notice(label: string): DataSourceItem[] {
	return [{ label, value: "", disabled: true }];
}

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
 * Triggers an OBS hotkey or flips a filter when the key is pressed.
 *
 * Everything the property inspector shows is fetched live from OBS, so the
 * dropdowns always reflect the instance the action is pointed at.
 */
@action({ UUID: "dev.voidscape.obs-extensions.trigger" })
export class ObsTriggerAction extends SingletonAction<TriggerSettings> {
	constructor() {
		super();

		// Keeps filter keys in step with changes made anywhere else, including
		// in the OBS interface itself.
		connectionManager.on("filterStateChanged", (ev) => {
			void this.#syncFilterState(ev.instanceId, ev.sourceName, ev.filterName, ev.enabled);
		});

		connectionManager.on("stateChanged", () => void this.#refreshFilterStates());
	}

	override async onWillAppear(ev: WillAppearEvent<TriggerSettings>): Promise<void> {
		await this.#renderFilterState(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TriggerSettings>): Promise<void> {
		await this.#backfillSourceUuid(ev.action, ev.payload.settings);
		await this.#renderFilterState(ev.action, ev.payload.settings);
	}

	/**
	 * The property inspector stores the source by name, since that is what the
	 * dropdown shows. Resolving the UUID alongside it lets requests target the
	 * source by UUID instead, so a later rename in OBS does not break the key.
	 */
	async #backfillSourceUuid(
		target: KeyAction<TriggerSettings> | DialAction<TriggerSettings>,
		settings: TriggerSettings,
	): Promise<void> {
		const { instanceId, sourceName } = settings;
		if (!instanceId || !sourceName || !connectionManager.isConnected(instanceId)) {
			return;
		}

		try {
			const source = await findSource(instanceId, sourceName);
			if (source?.uuid && source.uuid !== settings.sourceUuid) {
				await target.setSettings({ ...settings, sourceUuid: source.uuid });
			}
		} catch {
			// Best effort; requests fall back to targeting by name.
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TriggerSettings>): Promise<void> {
		const settings = ev.payload.settings;

		try {
			await this.#execute(ev.action, settings);
			await ev.action.showOk();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS trigger failed: ${message}`);
			await ev.action.showAlert();
		}
	}

	async #execute(
		target: KeyAction<TriggerSettings> | DialAction<TriggerSettings>,
		settings: TriggerSettings,
	): Promise<void> {
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

			const enabled = await applyFilterOperation(
				instanceId,
				{ name: settings.sourceName, uuid: settings.sourceUuid },
				settings.filterName,
				settings.filterOperation ?? "toggle",
			);

			if (target.isKey()) {
				await target.setState(enabled ? 1 : 0);
			}

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
				await streamDeck.ui.sendToPropertyInspector({
					event,
					items: connectionManager.getInstances().map((instance) => ({
						label: instance.name,
						value: instance.id,
					})),
				});
				break;

			case "sources":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await this.#sourceItems(settings) });
				break;

			case "hotkeys":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await this.#hotkeyItems(settings) });
				break;

			case "filters":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await this.#filterItems(settings) });
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

	async #sourceItems(settings: TriggerSettings): Promise<DataSourceResult> {
		const { instanceId } = settings;
		if (!instanceId || !connectionManager.isConnected(instanceId)) {
			return notice("Connect to an OBS instance first");
		}

		try {
			const sources = await listSources(instanceId);
			if (sources.length === 0) {
				return notice("No sources found");
			}

			const inputs = sources.filter((source) => !source.isScene);
			const scenes = sources.filter((source) => source.isScene);
			const result: DataSourceResult = [];

			if (inputs.length > 0) {
				result.push({
					label: "Sources",
					children: inputs.map((source) => ({ label: source.name, value: source.name })),
				});
			}

			if (scenes.length > 0) {
				result.push({ label: "Scenes", children: scenes.map((scene) => ({ label: scene.name, value: scene.name })) });
			}

			return result;
		} catch (err) {
			streamDeck.logger.error("Failed to list OBS sources.", err);
			return notice("Could not load sources");
		}
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

	async #filterItems(settings: TriggerSettings): Promise<DataSourceResult> {
		const { instanceId, sourceName, sourceUuid } = settings;
		if (!instanceId || !connectionManager.isConnected(instanceId)) {
			return notice("Connect to an OBS instance first");
		}

		if (!sourceName) {
			return notice("Select a source first");
		}

		try {
			const filters = await listFilters(instanceId, { name: sourceName, uuid: sourceUuid });
			if (filters.length === 0) {
				return notice("That source has no filters");
			}

			return filters.map((filter) => ({ label: filter.name, value: filter.name }));
		} catch (err) {
			streamDeck.logger.error("Failed to list OBS filters.", err);
			return notice("Could not load filters");
		}
	}

	/* --- Filter state ---------------------------------------------------- */

	async #syncFilterState(instanceId: string, sourceName: string, filterName: string, enabled: boolean): Promise<void> {
		for (const current of this.actions) {
			if (!current.isKey()) {
				continue;
			}

			const settings = await current.getSettings();
			if (
				settings.kind === "filter" &&
				settings.instanceId === instanceId &&
				settings.sourceName === sourceName &&
				settings.filterName === filterName
			) {
				await current.setState(enabled ? 1 : 0);
			}
		}
	}

	async #refreshFilterStates(): Promise<void> {
		for (const current of this.actions) {
			const settings = await current.getSettings();
			await this.#renderFilterState(current, settings);
		}
	}

	/**
	 * Reads the filter's live state so the key is correct as soon as it
	 * appears, rather than only after the first press.
	 */
	async #renderFilterState(
		target: KeyAction<TriggerSettings> | DialAction<TriggerSettings>,
		settings: TriggerSettings,
	): Promise<void> {
		if (!target.isKey() || settings.kind !== "filter") {
			return;
		}

		const { instanceId, sourceName, sourceUuid, filterName } = settings;
		if (!instanceId || !sourceName || !filterName || !connectionManager.isConnected(instanceId)) {
			return;
		}

		try {
			const enabled = await isFilterEnabled(instanceId, { name: sourceName, uuid: sourceUuid }, filterName);
			await target.setState(enabled ? 1 : 0);
		} catch {
			// The filter or source may have been removed; leave the key as-is
			// rather than misreporting it as disabled.
		}
	}
}
