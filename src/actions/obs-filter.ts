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
import { applyFilterOperation, isFilterEnabled } from "../obs/sources";
import {
	DIAL_INTERACTIONS,
	NO_ACTION,
	type DialInteraction,
	type FilterAssignment,
	type FilterOperation,
	type FilterSettings,
} from "../obs/types";
import { parseDataSourceEvent, readAssignment, RotationThrottle } from "./dial";
import { backfillSourceUuids, filterItems, instanceItems, sourceItems } from "./property-inspector";

/** Key states, in the order the manifest declares them. */
const STATE_OFF = 0;
const STATE_ON = 1;

/** Touchscreen artwork, mirroring the two key states. */
const IMAGE_ON = "imgs/actions/filter/key-active@2x.png";
const IMAGE_OFF = "imgs/actions/filter/key@2x.png";

/** Every field one dial interaction stores, for reading it back out of settings. */
const ASSIGNMENT_FIELDS = [
	"sourceName",
	"sourceUuid",
	"filterName",
	"filterOperation",
] as const satisfies readonly (keyof FilterAssignment)[];

/**
 * What each dial interaction does until told otherwise: turning down switches
 * a filter off, turning up switches it on, and pressing toggles — the reading
 * of a dial that needs no explaining. These match the defaults the property
 * inspector shows, so a dial behaves the same whether or not it has been
 * opened.
 */
const DEFAULT_OPERATION: Record<DialInteraction, FilterOperation> = {
	turnLeft: "disable",
	turnRight: "enable",
	press: "toggle",
};

/** The interaction whose filter a dial reports on, when none has been chosen. */
const DEFAULT_FEEDBACK_INTERACTION: DialInteraction = "press";

function isSameFilter(a: FilterAssignment | undefined, b: FilterAssignment | undefined): boolean {
	return Boolean(a && b && a.sourceName === b.sourceName && a.filterName === b.filterName);
}

/** Whether an interaction has a filter to act on, and something to do to it. */
function isAssigned(assignment: FilterAssignment): boolean {
	return Boolean(assignment.filterName) && assignment.filterOperation !== NO_ACTION;
}

/**
 * Toggles a filter, and shows whether that filter is currently on.
 *
 * On a key a press toggles one filter. On a dial, turning left, turning right
 * and pressing each get their own filter and their own operation, so one dial
 * can switch a filter on one way and off the other, or drive three unrelated
 * filters.
 *
 * What is displayed is driven entirely by what OBS reports — the press itself
 * never flips it, and `DisableAutomaticStates` in the manifest stops Stream
 * Deck from flipping a key's state either. A filter switched from inside OBS,
 * from a second key, or by another client therefore lands on the action just
 * the same, and a press that fails leaves it showing the truth rather than an
 * optimistic guess.
 *
 * A dial's interactions may point at different filters, so only one of them
 * can be the one the touchscreen follows; the property inspector's "Show state
 * for" picks which.
 */
@action({ UUID: "dev.voidscape.obs-extensions.filter" })
export class ObsFilterAction extends SingletonAction<FilterSettings> {
	readonly #rotation = new RotationThrottle();

	constructor() {
		super();

		// Keeps actions in step with changes made anywhere else, including in
		// the OBS interface itself.
		connectionManager.on("filterStateChanged", (ev) => {
			void this.#applyToMatching(ev.instanceId, ev.sourceName, ev.filterName, ev.enabled);
		});

		// A reconnect is the one moment an action may have missed events, so
		// re-read rather than trusting what is on screen.
		connectionManager.on("stateChanged", () => void this.#renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<FilterSettings>): Promise<void> {
		await this.#render(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<FilterSettings>): Promise<void> {
		await backfillSourceUuids(ev.action, ev.payload.settings);
		await this.#render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<FilterSettings>): void {
		this.#rotation.forget(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<FilterSettings>): Promise<void> {
		const settings = ev.payload.settings;

		try {
			// A key has one filter and one behaviour: toggle it.
			const assignment = readAssignment<FilterAssignment>(settings, ASSIGNMENT_FIELDS);
			const enabled = await this.#apply(settings.instanceId, { ...assignment, filterOperation: "toggle" });

			// The event OBS sends back sets this too; doing it here as well
			// means the key is right immediately on a server that is quiet.
			await this.#show(ev.action, enabled);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS filter toggle failed: ${message}`);
			await ev.action.showAlert();
		}
	}

	/* --- Dial ------------------------------------------------------------ */

	override async onDialRotate(ev: DialRotateEvent<FilterSettings>): Promise<void> {
		const { ticks, settings } = ev.payload;
		if (ticks === 0) {
			return;
		}

		const interaction = ticks < 0 ? "turnLeft" : "turnRight";
		const assignment = this.#assignmentFor(settings, interaction);

		// Assignment first, throttle second: turning the way that has nothing
		// assigned should not hold up a turn straight back the other way.
		if (!isAssigned(assignment) || !this.#rotation.allows(ev.action.id)) {
			return;
		}

		await this.#fire(ev.action, settings, assignment, interaction);
	}

	override async onDialDown(ev: DialDownEvent<FilterSettings>): Promise<void> {
		await this.#activate(ev.action, ev.payload.settings, "press");
	}

	/** The touchscreen sits above its dial, so a tap is a press. */
	override async onTouchTap(ev: TouchTapEvent<FilterSettings>): Promise<void> {
		await this.#activate(ev.action, ev.payload.settings, "press");
	}

	/**
	 * Runs one dial interaction's assignment.
	 *
	 * An interaction with no filter chosen, or set to do nothing, stays silent
	 * rather than showing an alert; that is the configured behaviour, not a
	 * failure.
	 */
	async #activate(
		target: DialAction<FilterSettings>,
		settings: FilterSettings,
		interaction: DialInteraction,
	): Promise<void> {
		const assignment = this.#assignmentFor(settings, interaction);
		if (!isAssigned(assignment)) {
			return;
		}

		await this.#fire(target, settings, assignment, interaction);
	}

	/** Applies an assignment, and reports it when it is the one on display. */
	async #fire(
		target: DialAction<FilterSettings>,
		settings: FilterSettings,
		assignment: FilterAssignment,
		interaction: DialInteraction,
	): Promise<void> {
		try {
			const enabled = await this.#apply(settings.instanceId, assignment);

			// Only when this interaction is the one being reported on; the
			// others may well be pointed at an entirely different filter.
			if (isSameFilter(assignment, this.#displayedFilter(settings, true))) {
				await this.#show(target, enabled);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			streamDeck.logger.error(`OBS filter ${interaction} failed: ${message}`);
			await target.showAlert();
		}
	}

	/** One interaction's assignment, with the dial's default operation filled in. */
	#assignmentFor(settings: FilterSettings, interaction: DialInteraction): FilterAssignment {
		const assignment = readAssignment<FilterAssignment>(settings, ASSIGNMENT_FIELDS, interaction);

		return { ...assignment, filterOperation: assignment.filterOperation ?? DEFAULT_OPERATION[interaction] };
	}

	async #apply(instanceId: string | undefined, assignment: FilterAssignment): Promise<boolean> {
		if (!instanceId) {
			throw new Error("No OBS instance selected for this action.");
		}

		if (!connectionManager.isConnected(instanceId)) {
			throw new Error("Not connected to the selected OBS instance.");
		}

		const { sourceName, sourceUuid, filterName, filterOperation } = assignment;
		if (!sourceName || !filterName) {
			throw new Error("This action has no filter selected.");
		}

		if (filterOperation === NO_ACTION || filterOperation === undefined) {
			throw new Error("This action has no filter operation selected.");
		}

		return applyFilterOperation(instanceId, { name: sourceName, uuid: sourceUuid }, filterName, filterOperation);
	}

	/* --- Property inspector ---------------------------------------------- */

	/**
	 * Serves the property inspector's dropdowns.
	 *
	 * A dial's dropdowns come through with the interaction they belong to in
	 * the event name, since that is the only thing a datasource sends.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<{ event: string }, FilterSettings>): Promise<void> {
		const { event } = ev.payload;
		const { name, interaction } = parseDataSourceEvent(event);
		const settings = await ev.action.getSettings();

		const assignment = readAssignment<FilterAssignment>(settings, ASSIGNMENT_FIELDS, interaction);
		const scope = { instanceId: settings.instanceId, ...assignment };

		switch (name) {
			case "instances":
				await streamDeck.ui.sendToPropertyInspector({ event, items: instanceItems() });
				break;

			case "sources":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await sourceItems(scope) });
				break;

			case "filters":
				await streamDeck.ui.sendToPropertyInspector({ event, items: await filterItems(scope) });
				break;

			case "capabilities":
				await streamDeck.ui.sendToPropertyInspector({
					event,
					controller: ev.action.isDial() ? "Encoder" : "Keypad",
					connected: Boolean(settings.instanceId) && connectionManager.isConnected(settings.instanceId!),
				});
				break;
		}
	}

	/* --- Filter state ---------------------------------------------------- */

	/**
	 * The filter an action reports on.
	 *
	 * A key has only its own. A dial's interactions may each point somewhere
	 * different, so the user nominates one to follow; an interaction with no
	 * filter yet falls through to whichever has one, so a half-configured dial
	 * still shows something real rather than nothing at all.
	 */
	#displayedFilter(settings: FilterSettings, isDial: boolean): FilterAssignment | undefined {
		if (!isDial) {
			const { sourceName, sourceUuid, filterName } = settings;
			return filterName ? { sourceName, sourceUuid, filterName } : undefined;
		}

		const nominated = settings.feedbackInteraction ?? DEFAULT_FEEDBACK_INTERACTION;
		const candidates = [nominated, ...DIAL_INTERACTIONS.filter((interaction) => interaction !== nominated)];

		for (const interaction of candidates) {
			const assignment = readAssignment<FilterAssignment>(settings, ASSIGNMENT_FIELDS, interaction);
			if (assignment.filterName) {
				return assignment;
			}
		}

		return undefined;
	}

	/** Applies an OBS filter event to every action reporting on that filter. */
	async #applyToMatching(instanceId: string, sourceName: string, filterName: string, enabled: boolean): Promise<void> {
		for (const current of this.actions) {
			const settings = await current.getSettings();
			if (settings.instanceId !== instanceId) {
				continue;
			}

			if (isSameFilter(this.#displayedFilter(settings, current.isDial()), { sourceName, filterName })) {
				await this.#show(current, enabled);
			}
		}
	}

	async #renderAll(): Promise<void> {
		for (const current of this.actions) {
			await this.#render(current, await current.getSettings());
		}
	}

	/** Reads the filter's live state, so the action is correct as soon as it appears. */
	async #render(
		target: KeyAction<FilterSettings> | DialAction<FilterSettings>,
		settings: FilterSettings,
	): Promise<void> {
		const { instanceId } = settings;
		const displayed = this.#displayedFilter(settings, target.isDial());

		if (!instanceId || !displayed?.sourceName || !displayed.filterName || !connectionManager.isConnected(instanceId)) {
			return;
		}

		try {
			await this.#show(
				target,
				await isFilterEnabled(
					instanceId,
					{ name: displayed.sourceName, uuid: displayed.sourceUuid },
					displayed.filterName,
				),
			);
		} catch {
			// The filter or source may have been removed, or the connection may
			// have dropped mid-read; leave the action showing the last state
			// known to be real rather than misreporting it as off.
		}
	}

	/** Shows a filter's state: a key switches state, a dial redraws its touchscreen. */
	async #show(target: KeyAction<FilterSettings> | DialAction<FilterSettings>, enabled: boolean): Promise<void> {
		if (target.isKey()) {
			await target.setState(enabled ? STATE_ON : STATE_OFF);
			return;
		}

		await target.setFeedback({
			icon: enabled ? IMAGE_ON : IMAGE_OFF,
			value: enabled ? "On" : "Off",
		});
	}
}
