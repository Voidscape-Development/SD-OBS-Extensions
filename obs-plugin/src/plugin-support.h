/*
 * OBS Extensions - logging helpers
 */

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
