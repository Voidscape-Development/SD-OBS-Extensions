/*
 * OBS Extensions - companion plugin for the OBS Extensions Stream Deck plugin
 *
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
