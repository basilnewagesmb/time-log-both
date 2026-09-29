// Google Sheet sync for the Daily Work Log extension.
// Talks to the Apps Script web app in /sheets (see sheets/README.md).
(function () {
  "use strict";

  // Team sheet web app (sheets/Code.gs). The token only allows writing rows to the sheet.
  const SHEET_URL =
    "https://script.google.com/macros/s/AKfycbzs5VYA-0ecqpvyjW9jGBGhjvp2jzO9CnNN_dhAudRotWc0lzuLcgrrt-d7meGSAfFpvQ/exec";
  const SHEET_TOKEN = "2f14aba8-32ca-4e9d-9b43-828274de8838";

  // Apps Script web apps answer a POST with a redirect to script.googleusercontent.com,
  // which fetch follows; text/plain keeps it a "simple" request (no CORS preflight).
  async function post(payload) {
    let res;
    try {
      res = await fetch(SHEET_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ ...payload, token: SHEET_TOKEN }),
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

  // Replaces the developer's row for `date` with these entries (idempotent).
  // entries: [{ projectKey, projectName, issueKey, summary, seconds }]
  function syncDay({ date, developer, accountId, entries }) {
    return post({ date, developer, accountId, entries });
  }

  function localIsoDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  window.Sheet = { syncDay, localIsoDate };
})();
