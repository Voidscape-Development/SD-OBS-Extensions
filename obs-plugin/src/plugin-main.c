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
 * Adds nothing to the OBS UI. Its only job is to expose the parts of the
 * hotkey registry that obs-websocket cannot, as vendor requests on the
 * obs-websocket connection the Stream Deck plugin already holds.
 */

#include <obs-module.h>

#include "hotkey-vendor.h"
#include "plugin-support.h"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

MODULE_EXPORT const char *obs_module_name(void)
{
	return obs_module_text("Plugin.Name");
}

MODULE_EXPORT const char *obs_module_description(void)
{
	return obs_module_text("Plugin.Description");
}

bool obs_module_load(void)
{
	obs_log(LOG_INFO, "Loading version %s", PLUGIN_VERSION);
	return true;
}

/*
 * obs-websocket publishes its proc handler while its own module loads, so it
 * is not resolvable until every module has been loaded. Registering any
 * earlier silently no-ops.
 */
void obs_module_post_load(void)
{
	obsx_vendor_register();
}

void obs_module_unload(void)
{
	obsx_vendor_unregister();
	obs_log(LOG_INFO, "Unloaded");
}
