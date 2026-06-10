// Runs in the YouTube page's MAIN world (declared in manifest with
// `world: "MAIN"`). It is the only piece of our code that can read
// `window.ytInitialPlayerResponse` and `window.ytcfg`. Communicates with
// the isolated-world content script via window.postMessage.

declare global {
  interface Window {
    ytInitialPlayerResponse?: unknown;
    ytcfg?: { get?: (k: string) => unknown };
  }
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.type !== "NOTETAKER_REQUEST_PLAYER_RESPONSE") return;
  let innertubeContext: unknown = null;
  let innertubeApiKey: string | null = null;
  try {
    const cfg = window.ytcfg;
    if (cfg && typeof cfg.get === "function") {
      innertubeContext = cfg.get("INNERTUBE_CONTEXT") ?? null;
      const k = cfg.get("INNERTUBE_API_KEY");
      innertubeApiKey = typeof k === "string" ? k : null;
    }
  } catch {}
  window.postMessage(
    {
      type: "NOTETAKER_PLAYER_RESPONSE",
      token: data.token,
      payload: {
        playerResponse: window.ytInitialPlayerResponse ?? null,
        innertubeContext,
        innertubeApiKey,
      },
    },
    "*",
  );
});

export {};
