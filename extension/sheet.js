// Google Sheet sync for the Daily Work Log extension.
// Talks to the Apps Script web app in /sheets (see sheets/README.md). The web app URL and
// token are entered on settings.html and kept in this browser only, never in the repo.
(function () {
  "use strict";

  const STORAGE_KEY = "dwl.sheet";
  const URL_RE = /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/exec$/;

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch (_) { return {}; }
  }

  function setConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: cfg.url || "", token: cfg.token || "" }));
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.url && c.token);
  }

  function validUrl(url) { return URL_RE.test(url || ""); }

  // Apps Script web apps answer a POST with a redirect to script.googleusercontent.com,
  // which fetch follows; text/plain keeps it a "simple" request (no CORS preflight).
  async function post(payload, cfg = getConfig()) {
    if (!cfg.url || !cfg.token) throw new Error("Google Sheet isn't set up yet. Open Settings.");
    let res;
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...payload, token: cfg.token }),
        credentials: "omit",
        redirect: "follow",
      });
    } catch (e) {
      throw new Error(`Couldn't reach the Google Sheet web app: ${e.message}`);
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(/<html/i.test(text)
        ? "The web app returned a Google page instead of data. Redeploy it with access set to \"Anyone\"."
        : `Unexpected response from the web app (HTTP ${res.status}).`);
    }
    if (!data.ok) throw new Error(data.error || "Sheet update failed.");
    return data;
  }

  function ping(cfg) { return post({ action: "ping" }, cfg); }

  // Replaces the developer's row for `date` with these entries (idempotent).
  // entries: [{ projectKey, projectName, issueKey, summary, seconds }]
  function syncDay({ date, developer, accountId, entries }) {
    return post({ date, developer, accountId, entries });
  }

  function localIsoDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  window.Sheet = { getConfig, setConfig, isConfigured, validUrl, ping, syncDay, localIsoDate };
})();
