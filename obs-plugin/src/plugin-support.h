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

/* Logging helpers. */

#pragma once

#include <util/base.h>

#ifndef PLUGIN_NAME
#define PLUGIN_NAME "obs-extensions"
#endif

#ifndef PLUGIN_VERSION
#define PLUGIN_VERSION "0.0.0"
#endif

/* Prefixes every log line so the plugin is identifiable in the OBS log. */
#define obs_log(level, format, ...) blog(level, "[" PLUGIN_NAME "] " format, ##__VA_ARGS__)
