import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";

import { connectionManager } from "../obs/connection-manager";
import { listFilters, listSources } from "../obs/sources";
import {
	DIAL_INTERACTIONS,
	type DataSourceItem,
	type DataSourceResult,
	type DialInteraction,
	type SourceScope,
	type SourceScopedSettings,
} from "../obs/types";
import { interactionKey } from "./dial";

/**
 * Dropdown contents and the odd shared chore, for the actions whose property
 * inspectors ask OBS the same questions.
 */

/** Shown in place of a dropdown's contents when it cannot be populated. */
export function notice(label: string): DataSourceItem[] {
	return [{ label, value: "", disabled: true }];
}

/** Every configured instance, for the instance dropdown. */
export function instanceItems(): DataSourceItem[] {
	return connectionManager.getInstances().map((instance) => ({ label: instance.name, value: instance.id }));
}

/** Inputs and scenes on the selected instance, grouped and alphabetical. */
export async function sourceItems(scope: SourceScope): Promise<DataSourceResult> {
	const { instanceId } = scope;
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
			result.push({ label: "Sources", children: inputs.map((source) => ({ label: source.name, value: source.name })) });
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

/** Filters on the selected source. */
export async function filterItems(scope: SourceScope): Promise<DataSourceResult> {
	const { instanceId, sourceName, sourceUuid } = scope;
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

/**
 * Resolves the selected sources' UUIDs and stores them alongside their names,
 * so requests can target a source by UUID; a rename in OBS then leaves the
 * action working rather than pointing at a name that no longer exists.
 *
 * A key has one source to resolve, a dial one per interaction, and they are
 * written back together so a dial costs the same single settings round trip a
 * key always did.
 */
export async function backfillSourceUuids<T extends SourceScopedSettings>(
	target: KeyAction<T> | DialAction<T>,
	settings: T,
): Promise<void> {
	const { instanceId } = settings;
	if (!instanceId || !connectionManager.isConnected(instanceId)) {
		return;
	}

	/** A key's single source is stored unprefixed, hence the `undefined`. */
	const interactions: (DialInteraction | undefined)[] = target.isDial() ? [...DIAL_INTERACTIONS] : [undefined];
	const updates: Record<string, string> = {};

	try {
		const sources = await listSources(instanceId);

		for (const interaction of interactions) {
			const nameKey = interaction ? interactionKey(interaction, "sourceName") : "sourceName";
			const uuidKey = interaction ? interactionKey(interaction, "sourceUuid") : "sourceUuid";

			const sourceName = settings[nameKey];
			if (typeof sourceName !== "string" || !sourceName) {
				continue;
			}

			const uuid = sources.find((source) => source.name === sourceName)?.uuid;
			if (uuid && uuid !== settings[uuidKey]) {
				updates[uuidKey] = uuid;
			}
		}
	} catch {
		// Best effort; requests fall back to targeting by name.
		return;
	}

	// Only when something actually changed: writing settings comes straight
	// back as a settings event, which is where this is called from.
	if (Object.keys(updates).length > 0) {
		await target.setSettings({ ...settings, ...updates } as T);
	}
}
