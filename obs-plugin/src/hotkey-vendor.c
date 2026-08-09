/*
 * OBS Extensions - companion plugin for the OBS Extensions Stream Deck plugin
 * Copyright (C) 2026 Voidscape Media
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 2 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * SPDX-License-Identifier: GPL-2.0-only
 */

/*
 * obs-websocket vendor implementation.
 *
 * Exposes the hotkey registry over obs-websocket in a form that is actually
 * usable by a remote client. See vendor-protocol.h for the wire contract and
 * the reasoning behind it.
 */

#include <string.h>

#include <obs-module.h>
#include <obs-hotkey.h>
#include <util/bmem.h>
#include <util/base.h>

#include "obs-websocket-api.h"

#include "hotkey-vendor.h"
#include "vendor-protocol.h"
#include "plugin-support.h"

static obs_websocket_vendor vendor = NULL;

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

static const char *registerer_type_name(obs_hotkey_registerer_t type)
{
	switch (type) {
	case OBS_HOTKEY_REGISTERER_FRONTEND:
		return "frontend";
	case OBS_HOTKEY_REGISTERER_SOURCE:
		return "source";
	case OBS_HOTKEY_REGISTERER_OUTPUT:
		return "output";
	case OBS_HOTKEY_REGISTERER_ENCODER:
		return "encoder";
	case OBS_HOTKEY_REGISTERER_SERVICE:
		return "service";
	}

	return "unknown";
}

/* Treats NULL as the empty string so callers can compare optional fields. */
static bool str_eq(const char *a, const char *b)
{
	if (!a)
		a = "";
	if (!b)
		b = "";

	return strcmp(a, b) == 0;
}

static bool str_empty(const char *s)
{
	return !s || !*s;
}

/*
 * The context a hotkey was registered against, resolved to plain strings.
 *
 * Only source-registered hotkeys carry a UUID and a kind; outputs, encoders
 * and services have names alone, and frontend hotkeys have no context at all.
 */
struct hotkey_context {
	char *name;
	char *uuid;
	char *kind;
};

static void hotkey_context_free(struct hotkey_context *ctx)
{
	bfree(ctx->name);
	bfree(ctx->uuid);
	bfree(ctx->kind);

	ctx->name = NULL;
	ctx->uuid = NULL;
	ctx->kind = NULL;
}

/*
 * Resolves the weak reference a hotkey was registered with. The registerer
 * type tells us which flavour of weak reference we are holding; upgrading it
 * can fail if the owning object is midway through destruction, which we treat
 * as "no context".
 */
static void hotkey_context_get(obs_hotkey_t *key, struct hotkey_context *ctx)
{
	memset(ctx, 0, sizeof(*ctx));

	void *registerer = obs_hotkey_get_registerer(key);
	if (!registerer)
		return;

	switch (obs_hotkey_get_registerer_type(key)) {
	case OBS_HOTKEY_REGISTERER_SOURCE: {
		obs_source_t *source = obs_weak_source_get_source((obs_weak_source_t *)registerer);
		if (!source)
			return;

		ctx->name = bstrdup(obs_source_get_name(source));
		ctx->uuid = bstrdup(obs_source_get_uuid(source));
		/* Unversioned, to match the inputKind obs-websocket reports. */
		ctx->kind = bstrdup(obs_source_get_unversioned_id(source));
		obs_source_release(source);
		break;
	}
	case OBS_HOTKEY_REGISTERER_OUTPUT: {
		obs_output_t *output = obs_weak_output_get_output((obs_weak_output_t *)registerer);
		if (!output)
			return;

		ctx->name = bstrdup(obs_output_get_name(output));
		obs_output_release(output);
		break;
	}
	case OBS_HOTKEY_REGISTERER_ENCODER: {
		obs_encoder_t *encoder = obs_weak_encoder_get_encoder((obs_weak_encoder_t *)registerer);
		if (!encoder)
			return;

		ctx->name = bstrdup(obs_encoder_get_name(encoder));
		obs_encoder_release(encoder);
		break;
	}
	case OBS_HOTKEY_REGISTERER_SERVICE: {
		obs_service_t *service = obs_weak_service_get_service((obs_weak_service_t *)registerer);
		if (!service)
			return;

		ctx->name = bstrdup(obs_service_get_name(service));
		obs_service_release(service);
		break;
	}
	case OBS_HOTKEY_REGISTERER_FRONTEND:
		break;
	}
}

static void respond_ok(obs_data_t *response)
{
	obs_data_set_bool(response, OBSX_FIELD_SUCCESS, true);
}

static void respond_error(obs_data_t *response, const char *message)
{
	obs_data_set_bool(response, OBSX_FIELD_SUCCESS, false);
	obs_data_set_string(response, OBSX_FIELD_ERROR, message);
}

/* ------------------------------------------------------------------------- */
/* GetVersion                                                                 */
/* ------------------------------------------------------------------------- */

static void request_get_version(obs_data_t *request_data, obs_data_t *response_data, void *priv_data)
{
	UNUSED_PARAMETER(request_data);
	UNUSED_PARAMETER(priv_data);

	respond_ok(response_data);
	obs_data_set_int(response_data, "protocolVersion", OBSX_VENDOR_PROTOCOL_VERSION);
	obs_data_set_string(response_data, "pluginVersion", PLUGIN_VERSION);
}

/* ------------------------------------------------------------------------- */
/* GetHotkeys                                                                 */
/* ------------------------------------------------------------------------- */

static bool enum_hotkey_cb(void *data, obs_hotkey_id id, obs_hotkey_t *key)
{
	obs_data_array_t *hotkeys = data;

	const char *name = obs_hotkey_get_name(key);
	if (str_empty(name))
		return true;

	struct hotkey_context ctx;
	hotkey_context_get(key, &ctx);

	obs_data_t *item = obs_data_create();
	obs_data_set_int(item, "id", (long long)id);
	obs_data_set_string(item, "name", name);
	obs_data_set_string(item, "description", obs_hotkey_get_description(key));
	obs_data_set_string(item, "registererType", registerer_type_name(obs_hotkey_get_registerer_type(key)));

	if (!str_empty(ctx.name))
		obs_data_set_string(item, "contextName", ctx.name);
	if (!str_empty(ctx.uuid))
		obs_data_set_string(item, "contextUuid", ctx.uuid);
	if (!str_empty(ctx.kind))
		obs_data_set_string(item, "contextKind", ctx.kind);

	obs_data_array_push_back(hotkeys, item);
	obs_data_release(item);
	hotkey_context_free(&ctx);

	return true;
}

static void request_get_hotkeys(obs_data_t *request_data, obs_data_t *response_data, void *priv_data)
{
	UNUSED_PARAMETER(request_data);
	UNUSED_PARAMETER(priv_data);

	obs_data_array_t *hotkeys = obs_data_array_create();
	obs_enum_hotkeys(enum_hotkey_cb, hotkeys);

	respond_ok(response_data);
	obs_data_set_array(response_data, "hotkeys", hotkeys);
	obs_data_array_release(hotkeys);
}

/* ------------------------------------------------------------------------- */
/* TriggerHotkey                                                              */
/* ------------------------------------------------------------------------- */

struct resolve_request {
	const char *name;
	const char *registerer_type;
	const char *context_uuid;
	const char *context_name;
	const char *description;

	/* When false, contextUuid is ignored and contextName is used instead. */
	bool use_uuid;

	/* Results. */
	obs_hotkey_id match;
	size_t match_count;
};

static bool resolve_hotkey_cb(void *data, obs_hotkey_id id, obs_hotkey_t *key)
{
	struct resolve_request *req = data;

	if (!str_eq(obs_hotkey_get_name(key), req->name))
		return true;

	if (!str_empty(req->registerer_type) &&
	    !str_eq(registerer_type_name(obs_hotkey_get_registerer_type(key)), req->registerer_type))
		return true;

	if (!str_empty(req->description) && !str_eq(obs_hotkey_get_description(key), req->description))
		return true;

	bool wants_uuid = req->use_uuid && !str_empty(req->context_uuid);
	bool wants_name = !wants_uuid && !str_empty(req->context_name);

	if (wants_uuid || wants_name) {
		struct hotkey_context ctx;
		hotkey_context_get(key, &ctx);

		bool matched = wants_uuid ? str_eq(ctx.uuid, req->context_uuid) : str_eq(ctx.name, req->context_name);
		hotkey_context_free(&ctx);

		if (!matched)
			return true;
	}

	if (req->match_count == 0)
		req->match = id;
	req->match_count++;

	return true;
}

static void request_trigger_hotkey(obs_data_t *request_data, obs_data_t *response_data, void *priv_data)
{
	UNUSED_PARAMETER(priv_data);

	struct resolve_request req = {
		.name = obs_data_get_string(request_data, "name"),
		.registerer_type = obs_data_get_string(request_data, "registererType"),
		.context_uuid = obs_data_get_string(request_data, "contextUuid"),
		.context_name = obs_data_get_string(request_data, "contextName"),
		.description = obs_data_get_string(request_data, "description"),
		.use_uuid = true,
		.match = OBS_INVALID_HOTKEY_ID,
		.match_count = 0,
	};

	if (str_empty(req.name)) {
		respond_error(response_data, "A hotkey 'name' is required.");
		return;
	}

	/*
	 * First pass honours the stored UUID. A source that was removed and
	 * re-added keeps its name but is issued a fresh UUID, so fall back to
	 * matching on name rather than leaving the button permanently broken.
	 */
	const char *matched_by = "uuid";
	obs_enum_hotkeys(resolve_hotkey_cb, &req);

	if (req.match_count == 0 && !str_empty(req.context_uuid) && !str_empty(req.context_name)) {
		req.use_uuid = false;
		matched_by = "name";
		obs_enum_hotkeys(resolve_hotkey_cb, &req);
	}

	if (req.match_count == 0) {
		respond_error(response_data, "No hotkey matched the supplied criteria.");
		return;
	}

	/*
	 * Triggered outside the enumeration: obs_enum_hotkeys holds the hotkey
	 * mutex for the duration of the callback, and the routed callback runs
	 * handlers that may register or unregister hotkeys of their own.
	 */
	obs_hotkey_trigger_routed_callback(req.match, true);
	obs_hotkey_trigger_routed_callback(req.match, false);

	respond_ok(response_data);
	obs_data_set_int(response_data, "hotkeyId", (long long)req.match);
	obs_data_set_int(response_data, "matches", (long long)req.match_count);
	obs_data_set_string(response_data, "matchedBy",
			    str_empty(req.context_uuid) && str_empty(req.context_name) ? "name" : matched_by);
}

/* ------------------------------------------------------------------------- */
/* Registration                                                               */
/* ------------------------------------------------------------------------- */

bool obsx_vendor_register(void)
{
	vendor = obs_websocket_register_vendor(OBSX_VENDOR_NAME);
	if (!vendor) {
		obs_log(LOG_WARNING, "obs-websocket is not available; hotkey requests will not be exposed. "
				     "Install obs-websocket 5.x (bundled with OBS 28+) and restart OBS.");
		return false;
	}

	bool ok = true;
	ok &= obs_websocket_vendor_register_request(vendor, OBSX_REQUEST_GET_VERSION, request_get_version, NULL);
	ok &= obs_websocket_vendor_register_request(vendor, OBSX_REQUEST_GET_HOTKEYS, request_get_hotkeys, NULL);
	ok &= obs_websocket_vendor_register_request(vendor, OBSX_REQUEST_TRIGGER_HOTKEY, request_trigger_hotkey, NULL);

	if (!ok) {
		obs_log(LOG_ERROR, "Failed to register one or more vendor requests.");
		return false;
	}

	obs_log(LOG_INFO, "Registered obs-websocket vendor '%s' (protocol version %d).", OBSX_VENDOR_NAME,
		OBSX_VENDOR_PROTOCOL_VERSION);

	return true;
}

void obsx_vendor_unregister(void)
{
	if (!vendor)
		return;

	obs_websocket_vendor_unregister_request(vendor, OBSX_REQUEST_GET_VERSION);
	obs_websocket_vendor_unregister_request(vendor, OBSX_REQUEST_GET_HOTKEYS);
	obs_websocket_vendor_unregister_request(vendor, OBSX_REQUEST_TRIGGER_HOTKEY);

	vendor = NULL;
}
