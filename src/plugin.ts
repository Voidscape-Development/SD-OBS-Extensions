import streamDeck from "@elgato/streamdeck";

import { ObsConnectionAction } from "./actions/obs-connection";
import { ObsTriggerAction } from "./actions/obs-trigger";
import { connectionManager } from "./obs/connection-manager";

// OBS WebSocket passwords pass through this plugin, so keep the default level
// above trace: trace logs every message exchanged with the Stream Deck.
streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new ObsConnectionAction());
streamDeck.actions.registerAction(new ObsTriggerAction());

streamDeck
	.connect()
	// Deferred until after connect() so that reading global settings, which is
	// a round trip to the Stream Deck, has a live connection to travel over.
	.then(() => connectionManager.initialize())
	.catch((err) => streamDeck.logger.error("Failed to start the OBS Extensions plugin.", err));
