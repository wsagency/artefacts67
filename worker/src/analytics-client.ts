import type { RuntimeObservation } from "./artifact-runtime.js";

// Self-contained and inert outside a share view. No storage, identity, document text or
// visitor input is read. A new server proof identifies one opening, not one person.
// Keep this as source text: bundlers add runtime helpers to serialized function bodies.
export const ANALYTICS_CLIENT = String.raw`(function observeShare() {
  const config = window.__wsaAnalytics;
  if (!config?.proof || window.__wsaAnalyticsRunning) return;
  window.__wsaAnalyticsRunning = true;
  let activeMs = 0;
  let lastTick = performance.now();
  let lastActivity = lastTick;
  let scroll = 0;
  let lastSent = "";
  const tick = () => {
    const time = performance.now();
    if (document.visibilityState === "visible" && document.hasFocus() && lastTick - lastActivity < 60000) {
      activeMs += Math.min(time - lastTick, 15000);
    }
    lastTick = time;
  };
  const depth = () => {
    const root = document.scrollingElement || document.documentElement;
    const percent = Math.min(100, Math.floor((root.scrollTop + window.innerHeight) / Math.max(1, root.scrollHeight) * 100));
    scroll = Math.max(scroll, Math.floor(percent / 25) * 25);
  };
  const send = () => {
    tick(); depth();
    const counters = Math.min(14400, Math.floor(activeMs / 1000)) + ":" + scroll;
    if (counters === lastSent) return;
    const body = JSON.stringify({ path: config.path, token: config.token, artifactId: config.artifactId,
      proof: config.proof, activeSeconds: Math.min(14400, Math.floor(activeMs / 1000)), scroll });
    try {
      // Keepalive survives pagehide without sending platform session cookies.
      fetch("/_ev", { method: "POST", body, headers: { "Content-Type": "application/json" },
        credentials: "omit", keepalive: true }).catch(() => {});
      lastSent = counters;
    } catch { /* Offline HTML remains fully usable. */ }
  };
  const activity = () => { tick(); lastActivity = performance.now(); };
  for (const event of ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"]) {
    window.addEventListener(event, activity, { passive: true });
  }
  document.addEventListener("visibilitychange", () => { send(); lastTick = performance.now(); });
  window.addEventListener("focus", activity);
  window.addEventListener("blur", send);
  window.addEventListener("pagehide", send);
  const timer = setInterval(send, 15000);
  setTimeout(() => clearInterval(timer), 4 * 60 * 60 * 1000);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", send, { once: true });
  else send();
})();`;
const safeJson = (value: RuntimeObservation) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
export const analyticsTag = (config?: RuntimeObservation) => `<script data-wsa-analytics>${config ? `window.__wsaAnalytics=${safeJson(config)};` : ""}${ANALYTICS_CLIENT}</script>`;

export function instrumentDocument(source: string, config?: RuntimeObservation): string {
  const text = String(source);
  // Newly sealed HTML already carries the generic beacon. Legacy versions receive the same
  // script on their authorized viewing path, without a republish or a storage rewrite.
  if (!config && text.includes("data-wsa-analytics")) return text;
  const tag = analyticsTag(config);
  const head = /<head\b[^>]*>/i.exec(text);
  if (head) {
    const at = head.index + head[0].length;
    return text.slice(0, at) + tag + text.slice(at);
  }
  return tag + text;
}
