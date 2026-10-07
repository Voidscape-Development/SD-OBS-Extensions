import streamDeck from "@elgato/streamdeck";

import { connectionManager } from "../obs/connection-manager";
import type { ConnectionStatus, ObsInstance } from "../obs/types";

/**
 * The Connections tab every property inspector carries.
 *
 * Stream Deck has no plugin-level settings screen, so the shared instance list
 * is edited from inside whichever action happens to be open: every action's
 * property inspector has a second tab for it, served from here. Each action
 * forwards its `sendToPlugin` messages through {@link handleConnectionRequest}
 * before looking at its own.
 */

/** A connection as the tab lists it: everything but the password. */
type ConnectionSummary = Omit<ObsInstance, "password"> & {
	status: ConnectionStatus;
	error: string;
	obsVersion: string;
	obsWebSocketVersion: string;
	companion: boolean;
};

export type ConnectionRequest = {
	event: string;
	instance?: ObsInstance;
	instanceId?: string;
};

/** Every event the tab sends, so actions can tell them from their own. */
const EVENTS = new Set(["connections", "getConnection", "saveConnection", "deleteConnection", "toggleConnection"]);

const DEFAULT_PORT = 4455;

function summaries(): ConnectionSummary[] {
	return connectionManager.getInstances().map(({ password: _password, ...instance }) => {
		const state = connectionManager.getState(instance.id);

		return {
			...instance,
			status: state?.status ?? "disconnected",
			error: state?.error ?? "",
			obsVersion: state?.obsVersion ?? "",
			obsWebSocketVersion: state?.obsWebSocketVersion ?? "",
			companion: state?.companion ?? false,
		};
	});
}

/**
 * Answers a Connections tab request.
 *
 * Returns `false` when the message is not one of the tab's, so the action can
 * carry on and handle it as its own.
 */
export async function handleConnectionRequest(payload: ConnectionRequest): Promise<boolean> {
	const { event, instanceId } = payload;
	if (!EVENTS.has(event)) {
		return false;
	}

	switch (event) {
		case "connections":
			await streamDeck.ui.sendToPropertyInspector({ event, connections: summaries() });
			break;

		case "getConnection":
			await streamDeck.ui.sendToPropertyInspector({
				event,
				instance: instanceId ? (connectionManager.getInstance(instanceId) ?? null) : null,
			});
			break;

		case "saveConnection": {
			const incoming = payload.instance;
			let id = "";

			if (incoming) {
				const instances = connectionManager.getInstances();
				id = incoming.id || globalThis.crypto.randomUUID();

				const record: ObsInstance = {
					id,
					name: String(incoming.name ?? "").trim() || "OBS",
					host: String(incoming.host ?? "").trim() || "127.0.0.1",
					port: Number(incoming.port) || DEFAULT_PORT,
					password: String(incoming.password ?? ""),
					autoConnect: Boolean(incoming.autoConnect),
				};

				const index = instances.findIndex((instance) => instance.id === id);
				if (index >= 0) {
					instances[index] = record;
				} else {
					instances.push(record);
				}

				// A new auto-connect instance comes up as part of the save.
				await connectionManager.saveInstances(instances);
			}

			await streamDeck.ui.sendToPropertyInspector({ event, instanceId: id });
			break;
		}

		case "deleteConnection": {
			const remaining = connectionManager.getInstances().filter((instance) => instance.id !== instanceId);

			await connectionManager.saveInstances(remaining);
			await streamDeck.ui.sendToPropertyInspector({ event, ok: true });
			break;
		}

		case "toggleConnection": {
			let error = "";
			try {
				if (instanceId) {
					await connectionManager.toggle(instanceId);
				}
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			}

			await streamDeck.ui.sendToPropertyInspector({ event, error });
			break;
		}
	}

	return true;
}

/**
 * Keeps an open Connections tab live: every status change and every edit to
 * the instance list is pushed to whichever property inspector is showing, so
 * the tab never needs a refresh button and the action's own dropdowns can
 * follow along.
 */
export function pushConnectionUpdates(): void {
	const push = (reason: "state" | "instances"): void => {
		streamDeck.ui
			.sendToPropertyInspector({ event: "connectionsChanged", reason, connections: summaries() })
			// Nothing is listening when no property inspector is open.
			.catch(() => undefined);
	};

	connectionManager.on("stateChanged", () => push("state"));
	connectionManager.on("instancesChanged", () => push("instances"));
}
