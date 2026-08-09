/*
 * OBS Extensions - obs-websocket vendor registration
 */

#pragma once

#include <stdbool.h>

/*
 * Registers the vendor and its requests with obs-websocket.
 *
 * Must be called from obs_module_post_load(): obs-websocket registers its proc
 * handler during its own module load, so the handler is not resolvable until
 * every module has loaded.
 *
 * Returns false when obs-websocket is not installed, in which case the rest of
 * this plugin simply does nothing.
 */
bool obsx_vendor_register(void);

/* Unregisters the vendor requests. Safe to call when registration failed. */
void obsx_vendor_unregister(void);
