/**
 * What the app should do about its own version. Set per platform in the environment:
 * - APP_MIN_VERSION_IOS / APP_MIN_VERSION_ANDROID: older apps must update before use
 *   (a screen they can't dismiss). Leave empty to never require an update.
 * - APP_LATEST_VERSION_IOS / APP_LATEST_VERSION_ANDROID: optional; newer than the app means
 *   an "Update available" prompt. iOS also reads the App Store, so this is mainly for Android.
 * - APP_STORE_URL_IOS / APP_STORE_URL_ANDROID: optional store links for the Update button.
 */
export type AppPlatformVersionConfig = {
  minimumVersion: string | null;
  latestVersion: string | null;
  storeUrl: string | null;
};

export type AppVersionConfig = {
  ios: AppPlatformVersionConfig;
  android: AppPlatformVersionConfig;
};

const VERSION_RE = /^\d+(\.\d+){0,3}$/;

export const normalizeAppVersion = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return VERSION_RE.test(text) ? text : null;
};

const normalizeStoreUrl = (value: unknown) => {
  const text = typeof value === "string" ? value.trim() : "";
  return /^https:\/\//.test(text) ? text : null;
};

export function getAppVersionConfig(env: Record<string, string | undefined> = process.env): AppVersionConfig {
  const platform = (suffix: "IOS" | "ANDROID"): AppPlatformVersionConfig => ({
    minimumVersion: normalizeAppVersion(env[`APP_MIN_VERSION_${suffix}`]),
    latestVersion: normalizeAppVersion(env[`APP_LATEST_VERSION_${suffix}`]),
    storeUrl: normalizeStoreUrl(env[`APP_STORE_URL_${suffix}`]),
  });
  return { ios: platform("IOS"), android: platform("ANDROID") };
}
