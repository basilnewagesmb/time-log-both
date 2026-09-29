/**
 * Daily Work Log -> Google Sheet
 *
 * Web app that receives each developer's time for the day from the Daily Work Log
 * Chrome extension and writes it into a daily block on the "Log" tab:
 *
 *            29 September 2026, Tuesday
 *   Developer | Project | Task | Hours
 *   Alan M    | Georgia | Dashboard | 8
 *
 * Tabs:
 *   Log      - daily blocks (created automatically)
 *   Team     - Developer | Jira account ID   (roster; pre-filled rows, in this order)
 *   Projects - Jira key | Short name         (e.g. GEOR -> Georgia)
 *
 * Setup: see README.md in this folder. Run setup() once from the editor.
 */

const LOG_SHEET = "Log";
const TEAM_SHEET = "Team";
const PROJECTS_SHEET = "Projects";
const COLS = 4; // Developer | Project | Task | Hours
const HEADERS = ["Developer", "Project", "Task", "Hours"];

// ---------- Entry points ----------

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!checkToken_(p.token)) return json_({ ok: false, error: "Invalid token" });

  // Optional: cron can call ?action=prepare to create today's block (with blank rows
  // for the whole team) before the reminder goes out.
  if (p.action === "prepare") {
    const date = p.date && isIsoDate_(p.date) ? p.date : todayIso_();
    withLock_(() => ensureBlock_(date));
    return json_({ ok: true, date: date });
  }
  return json_({ ok: true, message: "Daily Work Log sheet endpoint is running." });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "Request body must be JSON." });
  }
  if (!checkToken_(body.token)) return json_({ ok: false, error: "Invalid token" });
  if (body.action === "ping") return json_({ ok: true, message: "Connected." });

  if (!isIsoDate_(body.date)) return json_({ ok: false, error: "date must be YYYY-MM-DD" });
  if (!body.developer || typeof body.developer !== "string") {
    return json_({ ok: false, error: "developer is required" });
  }
  if (!Array.isArray(body.entries)) return json_({ ok: false, error: "entries must be an array" });

  try {
    const result = withLock_(() => upsertDeveloperRow_(body));
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Run once from the Apps Script editor: creates the tabs and a secret token.
function setup() {
  const ss = SpreadsheetApp.getActive();
  const team = ss.getSheetByName(TEAM_SHEET) || ss.insertSheet(TEAM_SHEET);
  if (team.getLastRow() === 0) {
    team.getRange(1, 1, 1, 2).setValues([["Developer", "Jira account ID (filled automatically)"]]).setFontWeight("bold");
    team.setFrozenRows(1);
    team.setColumnWidths(1, 2, 260);
  }
  const projects = ss.getSheetByName(PROJECTS_SHEET) || ss.insertSheet(PROJECTS_SHEET);
  if (projects.getLastRow() === 0) {
    projects.getRange(1, 1, 1, 2).setValues([["Jira key", "Short name"]]).setFontWeight("bold");
    projects.setFrozenRows(1);
  }
  const log = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET, 0);
  log.setColumnWidth(1, 160);
  log.setColumnWidth(2, 260);
  log.setColumnWidth(3, 360);
  log.setColumnWidth(4, 90);

  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty("TOKEN");
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty("TOKEN", token);
  }
  Logger.log("Token for the extension settings: " + token);
}

// ---------- Core ----------

function upsertDeveloperRow_(body) {
  const sheet = getLogSheet_();
  const name = resolveDeveloper_(body.developer, body.accountId);
  const row = summarize_(body.entries);
  let block = ensureBlock_(body.date);

  // Find this developer's row in the block (case-insensitive name match).
  let target = -1;
  if (block.lastRow > block.headerRow) {
    const names = sheet.getRange(block.headerRow + 1, 1, block.lastRow - block.headerRow, 1).getValues();
    for (let i = 0; i < names.length; i++) {
      if (norm_(names[i][0]) === norm_(name)) { target = block.headerRow + 1 + i; break; }
    }
  }
  if (target === -1) {
    sheet.insertRowAfter(block.lastRow);
    target = block.lastRow + 1;
    block.lastRow = target;
  }

  sheet.getRange(target, 1, 1, COLS).setValues([[name, row.project, row.task, row.hours === 0 ? "" : row.hours]]);
  styleBlock_(sheet, block);
  return { row: target, developer: name, hours: row.hours };
}

// Sum a day's worklogs into Project / Task / Hours cells.
// entries: [{ projectKey, projectName, issueKey, summary, seconds }]
function summarize_(entries) {
  const aliases = projectAliases_();
  const byProject = {};
  const byTask = {};
  let total = 0;
  entries.forEach(function (e) {
    const secs = Math.max(0, Number(e.seconds) || 0);
    total += secs;
    const key = String(e.projectKey || "").toUpperCase();
    const pName = aliases[key] || e.projectName || key;
    if (pName) byProject[pName] = (byProject[pName] || 0) + secs;
    const task = String(e.summary || e.issueKey || "").trim();
    if (task) byTask[task] = (byTask[task] || 0) + secs;
  });
  // Most time first.
  const order = (m) => Object.keys(m).sort((a, b) => m[b] - m[a]);
  return {
    project: order(byProject).join(", "),
    task: order(byTask).join(", "),
    hours: Math.round((total / 3600) * 100) / 100,
  };
}

// Finds the block for `date`, or appends a new one pre-filled with the team.
// Returns { titleRow, headerRow, lastRow }.
function ensureBlock_(date) {
  const sheet = getLogSheet_();
  const title = titleFor_(date);
  const lastRow = sheet.getLastRow();

  if (lastRow > 0) {
    const colA = sheet.getRange(1, 1, lastRow, COLS).getDisplayValues();
    for (let r = 0; r < colA.length; r++) {
      if (colA[r][0] === title) {
        // Block runs until the first fully blank row.
        let end = r + 1; // header (0-based index)
        while (end + 1 < colA.length && colA[end + 1].some((v) => String(v).trim() !== "")) end++;
        return { titleRow: r + 1, headerRow: r + 2, lastRow: end + 1 };
      }
    }
  }

  const titleRow = lastRow === 0 ? 1 : lastRow + 2;
  const team = teamRoster_().map((t) => [t.name, "", "", ""]);
  sheet.getRange(titleRow, 1, 1, COLS).merge().setValue(title);
  sheet.getRange(titleRow + 1, 1, 1, COLS).setValues([HEADERS]);
  if (team.length) sheet.getRange(titleRow + 2, 1, team.length, COLS).setValues(team);
  const block = { titleRow: titleRow, headerRow: titleRow + 1, lastRow: titleRow + 1 + team.length };
  styleBlock_(sheet, block);
  return block;
}

function styleBlock_(sheet, block) {
  const title = sheet.getRange(block.titleRow, 1, 1, COLS);
  title.setFontWeight("bold").setFontSize(12).setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(block.titleRow, 30);

  sheet.getRange(block.headerRow, 1, 1, COLS)
    .setBackground("#000000").setFontColor("#ffffff").setFontWeight("bold").setHorizontalAlignment("center");

  const all = sheet.getRange(block.titleRow, 1, block.lastRow - block.titleRow + 1, COLS);
  all.setBorder(true, true, true, true, true, true, "#d9d9d9", SpreadsheetApp.BorderStyle.SOLID);

  const bodyRows = block.lastRow - block.headerRow;
  if (bodyRows > 0) {
    sheet.getRange(block.headerRow + 1, 1, bodyRows, 1).setFontWeight("bold");
    sheet.getRange(block.headerRow + 1, 2, bodyRows, 2).setWrap(true);
    sheet.getRange(block.headerRow + 1, 4, bodyRows, 1).setHorizontalAlignment("center").setNumberFormat("0.##");
  }
}

// ---------- Lookups ----------

function teamRoster_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TEAM_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues()
    .map((r, i) => ({ name: String(r[0]).trim(), accountId: String(r[1]).trim(), row: i + 2 }))
    .filter((t) => t.name);
}

// Prefer the roster's spelling. Match on Jira account ID, then name; remember the
// account ID on first match so renames in Jira don't create duplicate rows.
function resolveDeveloper_(displayName, accountId) {
  const roster = teamRoster_();
  const byId = accountId && roster.find((t) => t.accountId === accountId);
  if (byId) return byId.name;
  const byName = roster.find((t) => norm_(t.name) === norm_(displayName));
  if (byName) {
    if (accountId && !byName.accountId) {
      SpreadsheetApp.getActive().getSheetByName(TEAM_SHEET).getRange(byName.row, 2).setValue(accountId);
    }
    return byName.name;
  }
  return String(displayName).trim();
}

function projectAliases_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(PROJECTS_SHEET);
  const out = {};
  if (!sheet || sheet.getLastRow() < 2) return out;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach((r) => {
    const key = String(r[0]).trim().toUpperCase();
    const name = String(r[1]).trim();
    if (key && name) out[key] = name;
  });
  return out;
}

// ---------- Helpers ----------

function getLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET, 0);
}

function titleFor_(iso) {
  const p = iso.split("-").map(Number);
  // Noon UTC keeps the calendar date stable in any time zone.
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
  return Utilities.formatDate(d, Session.getScriptTimeZone(), "d MMMM yyyy, EEEE");
}

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function isIsoDate_(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function norm_(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function checkToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty("TOKEN");
  return !!expected && token === expected;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
