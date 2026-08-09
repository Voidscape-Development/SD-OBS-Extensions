/*
 * OBS Extensions - obs-websocket vendor protocol
 *
 * This header is the single source of truth for the request/response contract
 * shared with the Stream Deck plugin. The TypeScript mirror of these constants
 * lives in src/obs/vendor-protocol.ts; keep the two in sync.
 */

#pragma once

/*
 * Vendor name registered with obs-websocket. Clients reach these requests via
 * the standard CallVendorRequest request:
 *
 *   {
 *     "vendorName":  "dev.voidscape.obs-extensions",
 *     "requestType": "GetHotkeys",
 *     "requestData": {}
 *   }
 */
#define OBSX_VENDOR_NAME "dev.voidscape.obs-extensions"

/*
 * Contract version. Bumped whenever the shape of a request or response changes
 * in a way that is not backwards compatible. The Stream Deck plugin refuses to
 * use the vendor when it reports a major version it does not understand, and
 * falls back to plain obs-websocket requests instead.
 */
#define OBSX_VENDOR_PROTOCOL_VERSION 1

/*
 * Requests.
 *
 * obs-websocket has no status channel for vendor requests: every call is
 * reported to the client as a success as long as the vendor and request type
 * exist. Failures are therefore signalled in the response body, and every
 * response carries a boolean "success" plus an "error" string when false.
 */

/*
 * GetVersion
 *
 * request:  {}
 * response: {
 *             "success":         true,
 *             "protocolVersion": 1,
 *             "pluginVersion":   "0.1.0"
 *           }
 *
 * Used by the Stream Deck plugin to detect whether the companion is installed.
 * A CallVendorRequest failure means "not installed"; a protocolVersion this
 * client does not understand means "installed but incompatible".
 */
#define OBSX_REQUEST_GET_VERSION "GetVersion"

/*
 * GetHotkeys
 *
 * request:  {}
 * response: {
 *             "success": true,
 *             "hotkeys": [
 *               {
 *                 "id":             42,
 *                 "name":           "libobs.mute",
 *                 "description":    "Mute",
 *                 "registererType": "source",
 *                 "contextName":    "Mic/Aux",
 *                 "contextUuid":    "4f8c...",
 *                 "contextKind":    "wasapi_input_capture"
 *               }
 *             ]
 *           }
 *
 * The whole point of the companion plugin: obs-websocket's GetHotkeyList
 * returns bare internal names with no descriptions, no owning context and no
 * de-duplication, which makes it impossible to tell which "libobs.mute"
 * belongs to which source. Enumerating in-process gives us the localized
 * description and the resolved registerer for each hotkey.
 *
 * "id" is only valid for the lifetime of this OBS session - ids are handed out
 * by an incrementing counter at registration time and are neither persisted
 * nor stable across restarts. Clients must not store it; store the composite
 * of name/registererType/contextUuid/description and let TriggerHotkey resolve
 * it to a live id.
 *
 * The context fields are absent for frontend hotkeys, and contextUuid/
 * contextKind are only present for source-registered hotkeys (outputs,
 * encoders and services have names but no UUIDs).
 */
#define OBSX_REQUEST_GET_HOTKEYS "GetHotkeys"

/*
 * TriggerHotkey
 *
 * request:  {
 *             "name":           "libobs.mute",   // required
 *             "registererType": "source",        // optional
 *             "contextUuid":    "4f8c...",       // optional
 *             "contextName":    "Mic/Aux",       // optional
 *             "description":    "Mute"           // optional
 *           }
 * response: {
 *             "success":   true,
 *             "hotkeyId":  42,
 *             "matches":   1,
 *             "matchedBy": "uuid"
 *           }
 *
 * Every supplied field narrows the search; all of them must match. Resolution
 * runs in two passes so that a source which was deleted and re-added (and so
 * carries a new UUID) still resolves: the first pass honours contextUuid, and
 * if that matches nothing the second falls back to contextName.
 *
 * "matches" reports how many hotkeys satisfied the constraints. A value above
 * one means the target was ambiguous and the first match was used; clients may
 * surface that as a configuration warning.
 */
#define OBSX_REQUEST_TRIGGER_HOTKEY "TriggerHotkey"

/* Response fields shared by every request. */
#define OBSX_FIELD_SUCCESS "success"
#define OBSX_FIELD_ERROR "error"
