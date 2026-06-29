import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

export default defineManifest({
  manifest_version: 3,
  name: "cnstlltn",
  short_name: "cnstlltn",
  description:
    "Generate notes from YouTube transcripts via an LLM and commit them to your GitHub knowledge base.",
  version: pkg.version,
  icons: {
    16: "src/assets/icon-16.png",
    32: "src/assets/icon-32.png",
    48: "src/assets/icon-48.png",
    128: "src/assets/icon-128.png",
  },
  action: {
    default_title: "Open cnstlltn side panel",
    default_icon: {
      16: "src/assets/icon-16.png",
      32: "src/assets/icon-32.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["*://*.youtube.com/*"],
      js: ["src/content/youtube.ts"],
      run_at: "document_idle",
    },
    // Main-world script so it can read window.ytInitialPlayerResponse;
      // crxjs's type doesn't include `world` yet, hence the cast.
    {
      matches: ["*://*.youtube.com/*"],
      js: ["src/content/yt-main.ts"],
      run_at: "document_idle",
      world: "MAIN",
    } as chrome.runtime.ManifestV3["content_scripts"] extends (infer U)[]
      ? U
      : never,
  ],
  side_panel: {
    default_path: "src/sidepanel/sidepanel.html",
  },
  options_page: "src/options/options.html",
  permissions: ["storage", "sidePanel", "scripting", "activeTab"],
  host_permissions: [
    "*://*.youtube.com/*",
    "https://api.github.com/*",
    "https://generativelanguage.googleapis.com/*",
  ],
});
