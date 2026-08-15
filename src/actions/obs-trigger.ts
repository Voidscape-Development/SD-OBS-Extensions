import streamDeck, {
	action,
	SingletonAction,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { connectionManager } from "../obs/connection-manager";
import { labelForHotkeyName } from "../obs/hotkey-catalog";
import { getHotkeyProvider, type HotkeyChoice } from "../obs/hotkey-provider";
import { applyFilterOperation, findSource } from "../obs/sources";
import {
	NO_ACTION,
	type DataSourceItem,
	type DataSourceResult,
	type DialInteraction,
	type FilterSetOperation,
	type HotkeyTarget,
	type TriggerAssignment,
	type TriggerSettings,
} from "../obs/types";
import { parseDataSourceEvent, readAssignment, RotationThrottle } from "./dial";
import { backfillSourceUuids, filterItems, instanceItems, notice, sourceItems } from "./property-inspector";

/** Every field one assignment stores, for reading it back out of settings. */
const ASSIGNMENT_FIELDS = [
	"kind",
	"sourceName",
	"sourceUuid",
	"hotkey",
	"filterName",
	"filterOperation",
] as const satisfies readonly (keyof TriggerAssignment)[];

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
 * the next time the action is opened.
 */
function toSetOperation(operation: string | undefined): FilterSetOperation {
	return operation === "disable" ? "disable" : "enable";
}

/** Whether an interaction has been given something to do. */
function isAssigned(assignment: TriggerAssignment): boolean {
	return assignment.kind !== undefined && assignment.kind !== NO_ACTION;
}

/**
 * Short description of what an assignment fires, for the dial's touchscreen
 * and for the interaction descriptions shown in the Stream Deck application.
 */
function describe(assignment: TriggerAssignment): string {
	if (!isAssigned(assignment)) {
		return "";
	}

	if (assignment.kind === "filter") {
		const verb = toSetOperation(assignment.filterOperation) === "disable" ? "Disable" : "Enable";
		return assignment.filterName ? `${verb} ${assignment.filterName}` : verb;
	}

	const hotkey = parseHotkey(assignment.hotkey);
	if (!hotkey) {
		return "";
	}

	return hotkey.description?.trim() || labelForHotkeyName(hotkey.name);
}

/**
 * Fires an OBS hotkey, or drives a filter to a known state.
 *
 * On a key that is the one thing a press does. On a dial, turning left,
 * turning right and pressing are each assigned separately and independently:
 * any of them can fire any hotkey or drive any filter on the instance, and any
 * of them can be left doing nothing.
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
	readonly #rotation = new RotationThrottle();

	override async onWillAppear(ev: WillAppearEvent<TriggerSettings>): Promise<void> {
		await backfillSourceUuids(ev.action, ev.payload.settings);
		await this.#describeInteractions(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TriggerSettings>): Promise<void> {
		await backfillSourceUuids(ev.action, ev.payload.settings);
		await this.#describeInteractions(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<TriggerSettings>): void {
		this.#rotation.forget(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<TriggerSettings>): Promise<void> {
		try {
			// A key stores its single trigger unprefixed, so no interaction.
			const assignment = readAssignment<TriggerAssignment>(ev.payload.settings, ASSIGNMENT_FIELDS);

			await this.#execute(ev.payload.settings.instanceId, assignment);
			await ev.action.showOk();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS trigger failed: ${message}`);
			await ev.action.showAlert();
		}
	}

	/* --- Dial ------------------------------------------------------------ */

	override async onDialRotate(ev: DialRotateEvent<TriggerSettings>): Promise<void> {
		const { ticks, settings } = ev.payload;
		if (ticks === 0) {
			return;
		}

		const interaction = ticks < 0 ? "turnLeft" : "turnRight";
		const assignment = readAssignment<TriggerAssignment>(settings, ASSIGNMENT_FIELDS, interaction);

		// Assignment first, throttle second: turning the way that has nothing
		// assigned should not hold up a turn straight back the other way.
		if (!isAssigned(assignment) || !this.#rotation.allows(ev.action.id)) {
			return;
		}

		await this.#fire(ev.action, settings.instanceId, assignment);
	}

	override async onDialDown(ev: DialDownEvent<TriggerSettings>): Promise<void> {
		await this.#activate(ev.action, ev.payload.settings, "press");
	}

	/** The touchscreen sits above its dial, so a tap is a press. */
	override async onTouchTap(ev: TouchTapEvent<TriggerSettings>): Promise<void> {
		await this.#activate(ev.action, ev.payload.settings, "press");
	}

	/**
	 * Runs one dial interaction's assignment.
	 *
	 * An interaction with nothing assigned stays silent rather than showing an
	 * alert; that is the configured behaviour, not a failure.
	 */
	async #activate(
		target: DialAction<TriggerSettings>,
		settings: TriggerSettings,
		interaction: DialInteraction,
	): Promise<void> {
		const assignment = readAssignment<TriggerAssignment>(settings, ASSIGNMENT_FIELDS, interaction);
		if (!isAssigned(assignment)) {
			return;
		}

		await this.#fire(target, settings.instanceId, assignment);
	}

	/**
	 * Fires an assignment and reports it on the touchscreen.
	 *
	 * The dial is left showing what was last sent to OBS, which is all this
	 * action ever knows — whether the hotkey did anything at the far end is not
	 * reported back.
	 */
	async #fire(
		target: DialAction<TriggerSettings>,
		instanceId: string | undefined,
		assignment: TriggerAssignment,
	): Promise<void> {
		try {
			await this.#execute(instanceId, assignment);
			await target.setFeedback({ value: describe(assignment) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS trigger failed: ${message}`);

			// Clear the label as well, so the dial is not left claiming the last
			// thing that worked as though it had just happened again.
			await target.setFeedback({ value: "" });
			await target.showAlert();
		}
	}

	/**
	 * Tells the Stream Deck application what this dial's interactions do, so
	 * the action's tooltip describes the hotkeys actually chosen rather than
	 * the generic wording from the manifest.
	 */
	async #describeInteractions(
		target: KeyAction<TriggerSettings> | DialAction<TriggerSettings>,
		settings: TriggerSettings,
	): Promise<void> {
		if (!target.isDial()) {
			return;
		}

		const describeOf = (interaction: DialInteraction): string =>
			describe(readAssignment<TriggerAssignment>(settings, ASSIGNMENT_FIELDS, interaction));

		const [left, right, press] = [describeOf("turnLeft"), describeOf("turnRight"), describeOf("press")];
		const rotate = [left, right].filter(Boolean).join(" / ");

		await target.setTriggerDescription({
			rotate: rotate || undefined,
			push: press || undefined,
			touch: press || undefined,
		});
	}

	/* --- Firing ---------------------------------------------------------- */

	async #execute(instanceId: string | undefined, assignment: TriggerAssignment): Promise<void> {
		if (!instanceId) {
			throw new Error("No OBS instance selected for this action.");
		}

		if (!connectionManager.isConnected(instanceId)) {
			throw new Error("Not connected to the selected OBS instance.");
		}

		if (assignment.kind === "filter") {
			if (!assignment.sourceName || !assignment.filterName) {
				throw new Error("This action has no filter selected.");
			}

			await applyFilterOperation(
				instanceId,
				{ name: assignment.sourceName, uuid: assignment.sourceUuid },
				assignment.filterName,
				toSetOperation(assignment.filterOperation),
			);

			return;
		}

		const hotkey = parseHotkey(assignment.hotkey);
		if (!hotkey) {
			throw new Error("This action has no hotkey selected.");
		}

		await getHotkeyProvider(instanceId).trigger(hotkey);
	}

	/* --- Property inspector ---------------------------------------------- */

	/**
	 * Serves every dropdown in the property inspector.
	 *
	 * A dial's dropdowns come through with the interaction they belong to in
	 * the event name, since that is the only thing a datasource sends.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<{ event: string }, TriggerSettings>): Promise<void> {
		const { event } = ev.payload;
		const { name, interaction } = parseDataSourceEvent(event);
		const settings = await ev.action.getSettings();

		const assignment = readAssignment<TriggerAssignment>(settings, ASSIGNMENT_FIELDS, interaction);
		const scope = { instanceId: settings.instanceId, ...assignment };

		switch (name) {
			case "instances":
				await streamDeck.ui.sendToPropertyInspector({ event, items: instanceItems() });
				break;

			case "sources":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await sourceItems(scope) });
				break;

			case "hotkeys":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await this.#hotkeyItems(scope, assignment) });
				break;

			case "filters":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await filterItems(scope) });
				break;

			case "capabilities":
				await streamDeck.ui.sendToPropertyInspector({
					event,
					controller: ev.action.isDial() ? "Encoder" : "Keypad",
					...this.#capabilities(settings),
				});
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

	async #hotkeyItems(
		scope: { instanceId?: string; sourceName?: string },
		assignment: TriggerAssignment,
	): Promise<DataSourceResult> {
		const { instanceId } = scope;
		if (!instanceId || !connectionManager.isConnected(instanceId)) {
			return notice("Connect to an OBS instance first");
		}

		const provider = getHotkeyProvider(instanceId);

		try {
			let choices: HotkeyChoice[];

			if (assignment.kind === "sourceHotkey") {
				if (!scope.sourceName) {
					return notice("Select a source first");
				}

				const source = await findSource(instanceId, scope.sourceName);
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
