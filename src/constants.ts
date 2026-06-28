/**
 * App-level constants observed from captured Hevy traffic. These headers are
 * sent by the real app on every request; some endpoints (e.g. version gating)
 * may reject requests that omit them, so we send them by default.
 */

export const BASE_URL = "https://api.hevyapp.com";

/** Static, per-app API key (identical across users in captured traffic). */
export const API_KEY = "klean_kanteen_insulated";

/** Mimics the iOS app build the capture came from. Override via client options. */
export const DEFAULT_APP_VERSION = "3.1.0";
export const DEFAULT_APP_BUILD = "2092238";
export const DEFAULT_PLATFORM = "ios 26.2";
export const DEFAULT_USER_AGENT = `Hevy/${DEFAULT_APP_BUILD} CFNetwork/3860.300.31 Darwin/25.2.0`;
