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
  // Prefer the live player response (the player API updates it on SPA
  // navigation); fall back to ytInitialPlayerResponse (only set on full loads).
  let playerResponse: unknown = window.ytInitialPlayerResponse ?? null;
  try {
    const mp = document.getElementById("movie_player") as
      | (HTMLElement & { getPlayerResponse?: () => unknown })
      | null;
    const live = mp?.getPlayerResponse?.();
    if (live) playerResponse = live;
  } catch {}

  window.postMessage(
    {
      type: "NOTETAKER_PLAYER_RESPONSE",
      token: data.token,
      payload: { playerResponse, innertubeContext, innertubeApiKey },
    },
    "*",
  );
});

export {};
