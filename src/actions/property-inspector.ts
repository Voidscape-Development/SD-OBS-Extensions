import streamDeck, { type DialAction, type KeyAction } from "@elgato/streamdeck";

import { connectionManager } from "../obs/connection-manager";
import { findSource, listFilters, listSources } from "../obs/sources";
import type { DataSourceItem, DataSourceResult, SourceScopedSettings } from "../obs/types";

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
export async function sourceItems(settings: SourceScopedSettings): Promise<DataSourceResult> {
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
export async function filterItems(settings: SourceScopedSettings): Promise<DataSourceResult> {
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

/**
 * Resolves the selected source's UUID and stores it alongside the name, so
 * requests can target the source by UUID; a rename in OBS then leaves the key
 * working rather than pointing at a name that no longer exists.
 */
export async function backfillSourceUuid<T extends SourceScopedSettings>(
	target: KeyAction<T> | DialAction<T>,
	settings: T,
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
