import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json";

export default defineManifest({
  manifest_version: 3,
  name: "Notetaker",
  short_name: "Notetaker",
  description:
    "Generate notes from YouTube transcripts via an LLM and commit them to your GitHub knowledge base.",
  version: pkg.version,
  action: {
    default_title: "Open Notetaker side panel",
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
