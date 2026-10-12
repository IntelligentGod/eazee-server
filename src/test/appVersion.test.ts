import assert from "node:assert/strict";
import test from "node:test";

import { getAppVersionConfig, normalizeAppVersion } from "../appVersion";

test("app version config reads each platform and ignores bad values", () => {
  const config = getAppVersionConfig({
    APP_MIN_VERSION_IOS: " 1.0.2 ",
    APP_LATEST_VERSION_IOS: "not-a-version",
    APP_STORE_URL_IOS: "http://insecure.example",
    APP_MIN_VERSION_ANDROID: "",
    APP_LATEST_VERSION_ANDROID: "1.1",
    APP_STORE_URL_ANDROID: "https://play.google.com/store/apps/details?id=com.eazee.ai",
  });
  assert.deepEqual(config.ios, { minimumVersion: "1.0.2", latestVersion: null, storeUrl: null });
  assert.deepEqual(config.android, {
    minimumVersion: null,
    latestVersion: "1.1",
    storeUrl: "https://play.google.com/store/apps/details?id=com.eazee.ai",
  });
});

test("nothing set means no required update", () => {
  const config = getAppVersionConfig({});
  assert.equal(config.ios.minimumVersion, null);
  assert.equal(config.android.minimumVersion, null);
  assert.equal(normalizeAppVersion("1.0.1.4"), "1.0.1.4");
  assert.equal(normalizeAppVersion("v1"), null);
});
