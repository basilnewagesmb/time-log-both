(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const url = $("sheet-url");
  const token = $("sheet-token");
  const err = $("settings-error");
  const ok = $("settings-ok");
  const save = $("save");

  function show(el, msg) { el.textContent = msg; el.hidden = !msg; }

  const cfg = Sheet.getConfig();
  url.value = cfg.url || "";
  token.value = cfg.token || "";

  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    show(err, ""); show(ok, "");
    const next = { url: url.value.trim(), token: token.value.trim() };
    if (!Sheet.validUrl(next.url)) {
      url.focus();
      return show(err, "Paste the web app URL from Deploy → Manage deployments. It ends in /exec.");
    }
    if (!next.token) {
      token.focus();
      return show(err, "Enter the token.");
    }
    save.disabled = true;
    save.setAttribute("aria-busy", "true");
    try {
      await Sheet.ping(next);
      Sheet.setConfig(next);
      show(ok, "Connected. Saved.");
    } catch (e2) {
      show(err, e2.message);
    } finally {
      save.disabled = false;
      save.removeAttribute("aria-busy");
    }
  });

  $("clear").addEventListener("click", () => {
    Sheet.setConfig({});
    url.value = "";
    token.value = "";
    show(err, "");
    show(ok, "Disconnected. Time will no longer be sent to the sheet.");
  });
})();
