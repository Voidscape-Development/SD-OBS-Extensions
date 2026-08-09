import { connectionManager } from "./connection-manager";
import type { SourceRef } from "./hotkey-provider";
import type { FilterOperation } from "./types";

/** A filter attached to a source. */
export type FilterRef = {
	name: string;
	kind: string;
	enabled: boolean;
};

function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Every source a hotkey or filter can be attached to, alphabetically.
 *
 * Scenes are included alongside inputs because filters apply to both, and
 * scenes own their items' visibility hotkeys.
 */
export async function listSources(instanceId: string): Promise<SourceRef[]> {
	const [inputs, scenes] = await Promise.all([
		connectionManager.call(instanceId, "GetInputList"),
		connectionManager.call(instanceId, "GetSceneList"),
	]);

	const sources: SourceRef[] = inputs.inputs.map((input) => ({
		name: String(input.inputName),
		uuid: input.inputUuid ? String(input.inputUuid) : undefined,
		kind: input.inputKind ? String(input.inputKind) : undefined,
		isScene: false,
	}));

	sources.push(
		...scenes.scenes.map((scene) => ({
			name: String(scene.sceneName),
			uuid: scene.sceneUuid ? String(scene.sceneUuid) : undefined,
			isScene: true,
		})),
	);

	return sources.sort(byName);
}

/** Looks a source back up by the name persisted in an action's settings. */
export async function findSource(instanceId: string, sourceName: string): Promise<SourceRef | undefined> {
	const sources = await listSources(instanceId);
	return sources.find((source) => source.name === sourceName);
}

/**
 * Targets a source by UUID where the server supports it, falling back to its
 * name. UUIDs survive renames; names do not.
 */
function sourceRef(
	instanceId: string,
	source: { name: string; uuid?: string },
): { sourceUuid: string } | { sourceName: string } {
	return source.uuid && connectionManager.supportsUuids(instanceId)
		? { sourceUuid: source.uuid }
		: { sourceName: source.name };
}

export async function listFilters(
	instanceId: string,
	source: { name: string; uuid?: string },
): Promise<FilterRef[]> {
	const { filters } = await connectionManager.call(
		instanceId,
		"GetSourceFilterList",
		sourceRef(instanceId, source),
	);

	return filters
		.map((filter) => ({
			name: String(filter.filterName),
			kind: String(filter.filterKind ?? ""),
			enabled: Boolean(filter.filterEnabled),
		}))
		.sort(byName);
}

export async function isFilterEnabled(
	instanceId: string,
	source: { name: string; uuid?: string },
	filterName: string,
): Promise<boolean> {
	const filter = await connectionManager.call(instanceId, "GetSourceFilter", {
		...sourceRef(instanceId, source),
		filterName,
	});

	return filter.filterEnabled;
}

/**
 * Applies a filter operation.
 *
 * `toggle` reads the current state first, so the result is always the opposite
 * of what OBS actually has rather than of what the key last displayed.
 */
export async function applyFilterOperation(
	instanceId: string,
	source: { name: string; uuid?: string },
	filterName: string,
	operation: FilterOperation,
): Promise<boolean> {
	const enabled =
		operation === "toggle" ? !(await isFilterEnabled(instanceId, source, filterName)) : operation === "enable";

	await connectionManager.call(instanceId, "SetSourceFilterEnabled", {
		...sourceRef(instanceId, source),
		filterName,
		filterEnabled: enabled,
	});

	return enabled;
}
