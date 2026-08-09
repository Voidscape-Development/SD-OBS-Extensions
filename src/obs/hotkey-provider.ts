import streamDeck from "@elgato/streamdeck";

import { connectionManager } from "./connection-manager";
import {
	AMBIGUOUS_GLOBAL_HOTKEYS,
	AUDIO_HOTKEYS,
	GLOBAL_HOTKEYS,
	HOTKEYS_BY_INPUT_KIND,
	labelForHotkeyName,
	sceneItemHotkeys,
	type CuratedHotkey,
} from "./hotkey-catalog";
import type { HotkeyTarget } from "./types";
import { VendorRequest, type GetHotkeysResponse, type TriggerHotkeyResponse, type VendorHotkey } from "./vendor-protocol";

/** A hotkey offered in a property inspector dropdown. */
export type HotkeyChoice = {
	target: HotkeyTarget;
	label: string;
	/** Rendered as an `<optgroup>` heading. */
	group?: string;
	/** True when triggering this may hit a different object of the same name. */
	ambiguous?: boolean;
};

/** The source a hotkey list is being built for. */
export type SourceRef = {
	name: string;
	uuid?: string;
	/** Unversioned input kind; absent for scenes. */
	kind?: string;
	isScene: boolean;
};

/**
 * Discovers and triggers OBS hotkeys.
 *
 * Two implementations exist because obs-websocket alone cannot say which
 * hotkeys belong to which source. The vendor provider asks the companion OBS
 * plugin, which can; the heuristic provider infers from a curated catalog.
 */
export interface HotkeyProvider {
	readonly kind: "vendor" | "heuristic";
	listGlobalHotkeys(): Promise<HotkeyChoice[]>;
	listSourceHotkeys(source: SourceRef): Promise<HotkeyChoice[]>;
	trigger(target: HotkeyTarget): Promise<void>;
}

const SUGGESTED_GROUP = "Suggested";
const ALL_GROUP = "All hotkeys";

function byLabel(a: HotkeyChoice, b: HotkeyChoice): number {
	return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
}

/* -------------------------------------------------------------------------- */
/* Vendor provider                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Backed by the companion OBS plugin.
 *
 * Reports OBS's own localized hotkey descriptions and resolves each hotkey to
 * the object that registered it, so every entry is individually addressable
 * and survives source renames.
 */
class VendorHotkeyProvider implements HotkeyProvider {
	public readonly kind = "vendor" as const;

	constructor(private readonly instanceId: string) {}

	public async listGlobalHotkeys(): Promise<HotkeyChoice[]> {
		const hotkeys = await this.#fetch();

		return hotkeys
			.filter((hotkey) => hotkey.registererType !== "source")
			.map((hotkey) => this.#toChoice(hotkey, hotkey.contextName))
			.sort(byLabel);
	}

	public async listSourceHotkeys(source: SourceRef): Promise<HotkeyChoice[]> {
		const hotkeys = await this.#fetch();

		return hotkeys
			.filter((hotkey) => {
				if (hotkey.registererType !== "source") {
					return false;
				}

				return source.uuid && hotkey.contextUuid
					? hotkey.contextUuid === source.uuid
					: hotkey.contextName === source.name;
			})
			.map((hotkey) => this.#toChoice(hotkey))
			.sort(byLabel);
	}

	public async trigger(target: HotkeyTarget): Promise<void> {
		const response = await connectionManager.callVendor<TriggerHotkeyResponse>(
			this.instanceId,
			VendorRequest.triggerHotkey,
			target,
		);

		if ((response.matches ?? 0) > 1) {
			streamDeck.logger.warn(
				`Hotkey '${target.name}' matched ${response.matches} hotkeys; the first was triggered. ` +
					`Re-select the hotkey in the action's settings to make it unambiguous.`,
			);
		}
	}

	async #fetch(): Promise<VendorHotkey[]> {
		const response = await connectionManager.callVendor<GetHotkeysResponse>(
			this.instanceId,
			VendorRequest.getHotkeys,
		);

		return response.hotkeys ?? [];
	}

	/**
	 * OBS's description is the label users recognise, but plugin-registered
	 * hotkeys occasionally leave it blank, hence the fallbacks.
	 */
	#toChoice(hotkey: VendorHotkey, contextSuffix?: string): HotkeyChoice {
		const base = hotkey.description?.trim() || labelForHotkeyName(hotkey.name);
		const label = contextSuffix ? `${base} (${contextSuffix})` : base;

		return {
			label,
			target: {
				name: hotkey.name,
				registererType: hotkey.registererType,
				contextUuid: hotkey.contextUuid,
				contextName: hotkey.contextName,
				description: hotkey.description,
			},
		};
	}
}

/* -------------------------------------------------------------------------- */
/* Heuristic provider                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Backed by plain obs-websocket.
 *
 * `GetHotkeyList` returns bare names with no context, so a curated catalog
 * supplies the labels and the list is used only to confirm which names this
 * OBS build actually registers. Anything not covered by the catalog is still
 * offered under "All hotkeys" so nothing is unreachable.
 */
class HeuristicHotkeyProvider implements HotkeyProvider {
	public readonly kind = "heuristic" as const;

	constructor(private readonly instanceId: string) {}

	public async listGlobalHotkeys(): Promise<HotkeyChoice[]> {
		const available = await this.#availableNames();

		const suggested = GLOBAL_HOTKEYS.filter((hotkey) => available.has(hotkey.name)).map((hotkey) =>
			this.#toChoice(hotkey, SUGGESTED_GROUP, AMBIGUOUS_GLOBAL_HOTKEYS.has(hotkey.name)),
		);

		const covered = new Set(suggested.map((choice) => choice.target.name));
		const rest = [...available]
			.filter((name) => !covered.has(name))
			.map((name) => this.#toChoice({ name, label: labelForHotkeyName(name) }, ALL_GROUP));

		return [...suggested.sort(byLabel), ...rest.sort(byLabel)];
	}

	public async listSourceHotkeys(source: SourceRef): Promise<HotkeyChoice[]> {
		if (!connectionManager.supportsHotkeyContext(this.instanceId)) {
			// Without contextName, TriggerHotkeyByName would fire whichever
			// source registered the name first - worse than offering nothing.
			return [];
		}

		const available = await this.#availableNames();
		const candidates: CuratedHotkey[] = [];

		if (source.kind && HOTKEYS_BY_INPUT_KIND[source.kind]) {
			candidates.push(...HOTKEYS_BY_INPUT_KIND[source.kind]);
		}

		if (!source.isScene && (await this.#hasAudio(source))) {
			candidates.push(...AUDIO_HOTKEYS);
		}

		if (source.isScene) {
			candidates.push(...(await this.#sceneItemHotkeys(source)));
		}

		const suggested = candidates
			.filter((hotkey) => available.has(hotkey.name))
			.map((hotkey) => this.#toChoice(hotkey, SUGGESTED_GROUP, false, source));

		const covered = new Set(suggested.map((choice) => choice.target.name));
		const rest = [...available]
			.filter((name) => !covered.has(name))
			.map((name) => this.#toChoice({ name, label: labelForHotkeyName(name) }, ALL_GROUP, false, source));

		return [...suggested.sort(byLabel), ...rest.sort(byLabel)];
	}

	public async trigger(target: HotkeyTarget): Promise<void> {
		await connectionManager.call(this.instanceId, "TriggerHotkeyByName", {
			hotkeyName: target.name,
			...(target.contextName ? { contextName: target.contextName } : {}),
		});
	}

	/** De-duplicated; OBS reports one entry per registration, not per name. */
	async #availableNames(): Promise<Set<string>> {
		const { hotkeys } = await connectionManager.call(this.instanceId, "GetHotkeyList");
		return new Set(hotkeys);
	}

	/**
	 * libobs registers the mute/push-to-talk hotkeys for any input with an
	 * audio track, which cuts across input kinds - capture cards and browser
	 * sources have audio too. Asking OBS is more reliable than a kind list.
	 */
	async #hasAudio(source: SourceRef): Promise<boolean> {
		try {
			await connectionManager.call(this.instanceId, "GetInputMute", this.#inputRef(source));
			return true;
		} catch {
			return false;
		}
	}

	async #sceneItemHotkeys(source: SourceRef): Promise<CuratedHotkey[]> {
		try {
			const { sceneItems } = await connectionManager.call(this.instanceId, "GetSceneItemList", {
				sceneName: source.name,
			});

			return sceneItems.flatMap((item) => sceneItemHotkeys(String(item.sourceName)));
		} catch {
			return [];
		}
	}

	#inputRef(source: SourceRef): { inputUuid: string } | { inputName: string } {
		return source.uuid ? { inputUuid: source.uuid } : { inputName: source.name };
	}

	#toChoice(hotkey: CuratedHotkey, group: string, ambiguous = false, source?: SourceRef): HotkeyChoice {
		return {
			label: hotkey.label,
			group,
			ambiguous,
			target: {
				name: hotkey.name,
				// Name-based, so a rename breaks the target. The companion
				// plugin stores a UUID instead and does not have this problem.
				...(source ? { contextName: source.name } : {}),
			},
		};
	}
}

/* -------------------------------------------------------------------------- */

/**
 * Picks the best provider for an instance.
 *
 * Companion detection happens once per connection, so this is cheap enough to
 * call on every press and always reflects the current connection.
 */
export function getHotkeyProvider(instanceId: string): HotkeyProvider {
	return connectionManager.hasCompanion(instanceId)
		? new VendorHotkeyProvider(instanceId)
		: new HeuristicHotkeyProvider(instanceId);
}
