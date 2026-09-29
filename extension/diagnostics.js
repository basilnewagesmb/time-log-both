const out = document.getElementById("out");

function show(label, value, ok = true) {
  out.className = ok ? "ok" : "bad";
  out.textContent = `${label}\n\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`;
}

function run(label, fn) {
  return async () => {
    show(label, "Loading…");
    try {
      show(label, await fn());
    } catch (e) {
      show(label, `${e.auth ? "[SIGNED OUT] " : ""}${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`, false);
    }
  };
}

document.getElementById("btn-me").onclick = run("GET /myself", async () => {
  const me = await Jira.getMyself();
  return { displayName: me.displayName, initials: Jira.initials(me.displayName), accountId: me.accountId };
});
document.getElementById("btn-projects").onclick = run("Projects", async () => {
  const p = await Jira.getProjects();
  return `${p.length} projects (WHIP present: ${p.some((x) => x.key === "WHIP")})\n\n` +
    p.map((x) => `${x.key}  ${x.name}`).join("\n");
});
document.getElementById("btn-issues").onclick = run("WHIP stories assigned to me", async () => {
  const issues = await Jira.getIssues("WHIP", { storiesOnly: true });
  return `${issues.length} issues\n\n` + issues.map((i) => `${i.key}  [${i.category}/${i.status}]  ${i.summary}`).join("\n");
});
document.getElementById("btn-log").onclick = run("Log 0.25h", async () => {
  const key = document.getElementById("issue").value.trim().toUpperCase();
  const w = await Jira.logWork(key, 0.25, "Daily Work Log extension test - safe to delete");
  const xsrfRule = await Jira._isOriginStrippingEnabled();
  return `Logged worklog id ${w.id} on ${key}. Delete it from the issue's Work log tab.\n` +
    `Origin-stripping XSRF rule active: ${xsrfRule}`;
});
document.getElementById("btn-today").onclick = run("Today's worklogs", async () => {
  const logs = await Jira.getTodaysWorklogs();
  const total = logs.reduce((s, l) => s + l.hours, 0);
  return `${logs.length} entries, ${total.toFixed(2)}h total\n\n` +
    logs.map((l) => `${l.started.toLocaleTimeString()}  ${l.issueKey}  ${l.hours}h  ${l.note}`).join("\n");
});
