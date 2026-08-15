import { DIAL_INTERACTIONS, type DialInteraction, type SourceScopedSettings } from "../obs/types";

/**
 * Shared plumbing for the actions that also run on a Stream Deck + dial.
 *
 * A dial has three interactions the user can assign separately — turn left,
 * turn right, and press — and each of them stores the same fields a key does,
 * under keys named after the interaction. Everything here is about moving
 * between those two views: reading one interaction's assignment out of the
 * flat settings, and routing the property inspector's per-interaction
 * dropdowns to the right one.
 */

/** Interaction plus field, as it is stored: `turnLeft` + `hotkey` → `turnLeftHotkey`. */
export function interactionKey<F extends string>(
	interaction: DialInteraction,
	field: F,
): `${DialInteraction}${Capitalize<F>}` {
	return `${interaction}${capitalize(field)}` as `${DialInteraction}${Capitalize<F>}`;
}

/**
 * Reads one assignment out of an action's settings.
 *
 * Passing no interaction reads the unprefixed keys, which is where a key's
 * single assignment lives — and is exactly what the keypad actions wrote
 * before dials were supported, so existing keys keep working untouched.
 */
export function readAssignment<A extends object>(
	settings: SourceScopedSettings,
	fields: readonly (keyof A & string)[],
	interaction?: DialInteraction,
): A {
	const assignment: Record<string, unknown> = {};

	for (const field of fields) {
		assignment[field] = settings[interaction ? interactionKey(interaction, field) : field];
	}

	return assignment as A;
}

/**
 * Splits a property inspector datasource event into what it asks for and which
 * interaction it asks about: `hotkeysTurnLeft` is the turn-left interaction's
 * hotkey list, whereas a bare `hotkeys` belongs to a key.
 *
 * The interaction has to travel in the event name because a datasource sends
 * nothing but its own name.
 */
export function parseDataSourceEvent(event: string): { name: string; interaction?: DialInteraction } {
	for (const interaction of DIAL_INTERACTIONS) {
		const suffix = capitalize(interaction);

		if (event.length > suffix.length && event.endsWith(suffix)) {
			return { name: event.slice(0, -suffix.length), interaction };
		}
	}

	return { name: event };
}

/**
 * Rate limit for actions fired by turning a dial.
 *
 * One flick of a dial arrives as a burst of rotation events, and everything a
 * dial can be pointed at here is discrete — a hotkey, or a filter being
 * switched on or off. Firing one per event would send a spin's worth of "start
 * recording" at OBS, so a spin is collapsed to a sane rate instead. Turning a
 * detent at a time is well inside this and still fires every time.
 */
const ROTATE_INTERVAL_MS = 200;

/** Keeps a fast spin from firing its assigned action dozens of times. */
export class RotationThrottle {
	readonly #lastFired = new Map<string, number>();

	/** Whether this dial may fire now; records the time when it may. */
	public allows(actionId: string): boolean {
		const now = Date.now();
		const last = this.#lastFired.get(actionId);

		if (last !== undefined && now - last < ROTATE_INTERVAL_MS) {
			return false;
		}

		this.#lastFired.set(actionId, now);
		return true;
	}

	/** Drops a dial that has gone away, so the map tracks only live actions. */
	public forget(actionId: string): void {
		this.#lastFired.delete(actionId);
	}
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
