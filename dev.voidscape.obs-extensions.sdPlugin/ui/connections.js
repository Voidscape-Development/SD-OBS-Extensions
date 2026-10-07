/**
 * The Connections tab, shared by every action's property inspector.
 *
 * Stream Deck has no plugin-level settings screen, so the plugin's OBS
 * instances are managed from whichever action is open: each property inspector
 * has a Settings tab for the action itself and this tab beside it, which lists
 * every connection with its live status and adds, edits, connects and removes
 * them. The plugin pushes every status change while the inspector is open, so
 * nothing here ever needs refreshing by hand.
 *
 * A page opts in with a tab bar, a `.tab-panel` per tab and an empty
 * `#connections` panel; this script fills the panel and runs the tabs. Pages
 * that want to react to connections coming and going — to update a hint, or
 * reload a dropdown that needs a live connection — listen for the
 * `obsx:connections` event on `document`.
 */
(() => {
	const client = SDPIComponents.streamDeckClient;
	const el = (id) => document.getElementById(id);

	/** Stands in for an instance id while a new connection is being written. */
	const NEW = "new";

	const DEFAULTS = { name: "OBS", host: "127.0.0.1", port: 4455, password: "", autoConnect: true };

	const STATUS_LABELS = {
		connected: "Connected",
		connecting: "Connecting…",
		disconnected: "Offline",
		error: "Error",
	};

	/** How long the Remove button waits for its confirming second press. */
	const CONFIRM_MS = 3000;

	/** The latest list from the plugin, passwords excluded. */
	let connections = [];

	/** Id in the editor: an instance id, {@link NEW}, or empty for none. */
	let selectedId = "";

	let confirmTimer = 0;

	/* --- Plumbing --------------------------------------------------------- */

	/**
	 * Round trip to the plugin. sdpi-components matches responses by the echoed
	 * event name, so each operation uses a distinct one.
	 */
	async function rpc(event, payload = {}) {
		const response = await client.get(
			"sendToPlugin",
			"sendToPropertyInspector",
			(msg) => msg.payload?.event === event,
			{ event, ...payload },
		);

		return response.payload;
	}

	function announce(reason) {
		document.dispatchEvent(new CustomEvent("obsx:connections", { detail: { reason, connections } }));
	}

	/* --- Tabs ------------------------------------------------------------- */

	function showTab(name) {
		for (const tab of document.querySelectorAll(".tabs [data-tab]")) {
			tab.classList.toggle("active", tab.dataset.tab === name);
		}

		for (const panel of document.querySelectorAll(".tab-panel")) {
			panel.hidden = panel.dataset.tab !== name;
		}
	}

	for (const tab of document.querySelectorAll(".tabs [data-tab]")) {
		tab.addEventListener("click", () => showTab(tab.dataset.tab));
	}

	/* --- Markup ----------------------------------------------------------- */

	el("connections").innerHTML = `
		<div id="conn-list" class="conn-list"></div>

		<div class="buttons buttons-full">
			<button id="conn-add" type="button">Add connection</button>
		</div>

		<div id="conn-editor" hidden>
			<div id="conn-heading" class="heading"></div>

			<sdpi-item label="Name">
				<sdpi-textfield id="conn-name" placeholder="OBS"></sdpi-textfield>
			</sdpi-item>

			<sdpi-item label="Host">
				<sdpi-textfield id="conn-host" placeholder="127.0.0.1"></sdpi-textfield>
			</sdpi-item>

			<sdpi-item label="Port">
				<sdpi-textfield id="conn-port" placeholder="4455"></sdpi-textfield>
			</sdpi-item>

			<sdpi-item label="Password">
				<sdpi-password id="conn-password" placeholder="Leave blank if disabled"></sdpi-password>
			</sdpi-item>

			<sdpi-item label="Auto-connect">
				<sdpi-checkbox id="conn-autoConnect" label="Connect when Stream Deck starts"></sdpi-checkbox>
			</sdpi-item>

			<div class="buttons">
				<button id="conn-save" type="button">Save</button>
				<button id="conn-toggle" type="button">Connect</button>
				<button id="conn-remove" type="button">Remove</button>
			</div>

			<div id="conn-status" class="status"></div>
		</div>
	`;

	/* --- Rendering -------------------------------------------------------- */

	/** One line under a connection's name: its status, then what it runs. */
	function describe(connection) {
		if (connection.status === "error" && connection.error) {
			return connection.error;
		}

		const parts = [STATUS_LABELS[connection.status] ?? connection.status];
		if (connection.status === "connected") {
			if (connection.obsVersion) {
				parts.push(`OBS ${connection.obsVersion}`);
			}
			if (connection.obsWebSocketVersion) {
				parts.push(`obs-websocket ${connection.obsWebSocketVersion}`);
			}
			if (connection.companion) {
				parts.push("companion plugin");
			}
		} else {
			parts.push(`${connection.host}:${connection.port}`);
		}

		return parts.join(" · ");
	}

	function renderList() {
		const list = el("conn-list");
		list.replaceChildren();

		if (connections.length === 0) {
			const empty = document.createElement("div");
			empty.className = "hint";
			empty.textContent = "No OBS connections yet. Add one to point this plugin at OBS.";
			list.append(empty);
			return;
		}

		for (const connection of connections) {
			const row = document.createElement("button");
			row.type = "button";
			row.className = "conn-row";
			row.classList.toggle("selected", connection.id === selectedId);

			const dot = document.createElement("span");
			dot.className = `conn-dot ${connection.status}`;

			const text = document.createElement("span");
			text.className = "conn-text";

			const name = document.createElement("span");
			name.className = "conn-name";
			name.textContent = connection.name;

			const detail = document.createElement("span");
			detail.className = "conn-detail";
			detail.classList.toggle("error", connection.status === "error");
			detail.textContent = describe(connection);

			text.append(name, detail);
			row.append(dot, text);
			row.addEventListener("click", () => select(connection.id));

			list.append(row);
		}
	}

	function setStatus(text, isError = false) {
		const status = el("conn-status");
		status.textContent = text;
		status.classList.toggle("error", isError);
	}

	/** Brings the editor's buttons and status in line with the selection. */
	function renderEditor() {
		const editor = el("conn-editor");
		editor.hidden = !selectedId;

		if (!selectedId) {
			return;
		}

		const isNew = selectedId === NEW;
		const connection = connections.find((candidate) => candidate.id === selectedId);

		el("conn-heading").textContent = isNew ? "New connection" : `Edit ${connection?.name ?? "connection"}`;
		el("conn-save").textContent = isNew ? "Add" : "Save";
		el("conn-toggle").disabled = isNew;
		el("conn-remove").disabled = isNew;
		el("conn-toggle").textContent =
			connection?.status === "connected" || connection?.status === "connecting" ? "Disconnect" : "Connect";

		if (connection) {
			setStatus(describe(connection), connection.status === "error");
		}
	}

	function fill(instance) {
		el("conn-name").value = instance.name ?? "";
		el("conn-host").value = instance.host ?? "";
		el("conn-port").value = String(instance.port ?? "");
		el("conn-password").value = instance.password ?? "";
		el("conn-autoConnect").value = Boolean(instance.autoConnect);
	}

	function resetRemove() {
		clearTimeout(confirmTimer);
		confirmTimer = 0;
		el("conn-remove").textContent = "Remove";
		el("conn-remove").classList.remove("danger");
	}

	/* --- Actions ---------------------------------------------------------- */

	async function select(id) {
		resetRemove();
		selectedId = id;
		renderList();

		if (id === NEW) {
			fill(DEFAULTS);
			renderEditor();
			setStatus("Fill in the details from OBS's Tools → WebSocket Server Settings, then choose Add.");
			return;
		}

		renderEditor();

		// The list leaves passwords out, so the editor fetches the one record
		// that needs it.
		const { instance } = await rpc("getConnection", { instanceId: id });
		if (instance && selectedId === id) {
			fill(instance);
		}
	}

	async function reload() {
		const payload = await rpc("connections");
		connections = payload.connections ?? [];
		renderList();
		renderEditor();
	}

	el("conn-add").addEventListener("click", () => select(NEW));

	el("conn-save").addEventListener("click", async () => {
		const name = String(el("conn-name").value ?? "").trim();
		if (!name) {
			setStatus("Give the connection a name.", true);
			return;
		}

		const port = Number.parseInt(String(el("conn-port").value ?? ""), 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			setStatus("Port must be a number between 1 and 65535.", true);
			return;
		}

		const isNew = selectedId === NEW;
		const { instanceId } = await rpc("saveConnection", {
			instance: {
				id: isNew ? "" : selectedId,
				name,
				host: String(el("conn-host").value ?? "").trim() || "127.0.0.1",
				port,
				password: String(el("conn-password").value ?? ""),
				autoConnect: Boolean(el("conn-autoConnect").value),
			},
		});

		selectedId = instanceId || selectedId;
		await reload();

		const saved = connections.find((connection) => connection.id === selectedId);
		if (!saved || saved.status === "disconnected") {
			setStatus(isNew ? "Added." : "Saved.");
		}
	});

	el("conn-toggle").addEventListener("click", async () => {
		setStatus("Working…");

		const { error } = await rpc("toggleConnection", { instanceId: selectedId });
		await reload();

		if (error) {
			setStatus(error, true);
		}
	});

	el("conn-remove").addEventListener("click", async () => {
		// Two presses, so a stray click cannot take out a connection that
		// every action pointing at it depends on.
		if (!confirmTimer) {
			el("conn-remove").textContent = "Confirm";
			el("conn-remove").classList.add("danger");
			confirmTimer = setTimeout(resetRemove, CONFIRM_MS);
			return;
		}

		resetRemove();
		await rpc("deleteConnection", { instanceId: selectedId });

		selectedId = "";
		await reload();
	});

	/* --- Live updates ----------------------------------------------------- */

	client.sendToPropertyInspector.subscribe((msg) => {
		const payload = msg.payload;
		if (payload?.event !== "connectionsChanged") {
			return;
		}

		connections = payload.connections ?? [];

		if (selectedId && selectedId !== NEW && !connections.some((connection) => connection.id === selectedId)) {
			selectedId = "";
		}

		renderList();
		renderEditor();

		// Every page names its own instance dropdown `instance`; it lists the
		// connections, so it follows any change to them.
		if (payload.reason === "instances") {
			el("instance")?.refresh?.();
		}

		announce(payload.reason);
	});

	/* --- Start ------------------------------------------------------------ */

	(async () => {
		await reload().catch(() => undefined);

		// With nothing to connect to, the action's own settings have nothing to
		// offer either, so start where the first job is.
		if (connections.length === 0) {
			showTab("connections");
			await select(NEW);
		} else {
			showTab("settings");
		}
	})();
})();
