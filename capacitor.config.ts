import type { CapacitorConfig } from "@capacitor/cli";

const appId = process.env.CAP_APP_ID || "com.skybeast.ascension";
const appName = process.env.CAP_APP_NAME || "SkyBeast Ascension";
const liveUrl = (process.env.CAP_SERVER_URL || "").trim();

const config: CapacitorConfig = {
  appId,
  appName,
  webDir: "mobile_www"
};

if (liveUrl) {
  config.server = {
    url: liveUrl,
    cleartext: liveUrl.startsWith("http://")
  };
}

export default config;
