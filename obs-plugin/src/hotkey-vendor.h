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

/* obs-websocket vendor registration. */

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

/*
 * Drops the vendor handle. Safe to call when registration failed, and safe to
 * call from obs_module_unload(), where reaching back into obs-websocket is not
 * — see the implementation for why the requests are left alone.
 */
void obsx_vendor_unregister(void);
