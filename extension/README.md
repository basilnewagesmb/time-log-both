# Daily Work Log: Chrome extension for Jira Cloud

Logs time to **https://newagesmb.atlassian.net** using the Jira session already signed in to your browser. No API token and no backend.

## Load it

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension` folder.
4. After you edit any file, click the reload icon on the extension's card.

## Pin it

Click the puzzle-piece icon in the Chrome toolbar and click the pin next to **Daily Work Log**. Clicking the icon opens the log in a new tab.

## Check your Jira connection

With the extension loaded, open `chrome-extension://<extension-id>/diagnostics.html`. The ID is shown on the extension's card in `chrome://extensions`. The buttons run each Jira call on its own:

1. **Who am I**: `GET /rest/api/3/myself`
2. **List projects**: `GET /rest/api/3/project/search` (paginated)
3. **List WHIP stories**: `POST /rest/api/3/search/jql` (nextPageToken pagination)
4. **Log 0.25h**: `POST /rest/api/3/issue/{key}/worklog`. This writes a real worklog. Delete it afterwards from the issue's **Work log** tab.
5. **Today's worklogs**: the JQL `worklogAuthor = currentUser() AND worklogDate = startOfDay()`, then each issue's worklogs, filtered to you and today

## How the page picks what to show

- **Project:** the page opens on the project you last logged time to. That's the last project you logged to from this page, or failing that, your most recent worklog in Jira over the last 30 days. Recent projects are listed first under "Recently logged". WHIP is used when there's no history.
- **Tasks:** by default, open Stories *and* subtasks assigned to you. Each subtask is listed under its parent (main) task, so you can log time on either. The parent is included even if it's assigned to someone else; it's marked "Assigned to …". Turn off **Stories & subtasks** to list every open issue type assigned to you.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest. Host access to newagesmb.atlassian.net, plus `declarativeNetRequest` for the XSRF fix. |
| `background.js` | Opens `worklog.html` in a new tab when you click the toolbar icon. |
| `jira.js` | Jira client: `Jira.getMyself`, `getProjects`, `getIssues`, `logWork`, `getTodaysWorklogs`, `openJiraTab`. |
| `worklog.html` / `.css` / `.js` | The Daily Work Log UI. |
| `sheet.js` | Sends your day's total to the team Google Sheet (see `../sheets/README.md`). |
| `settings.html` / `.js` | Settings page (⚙ icon): Google Sheet web app URL and token, stored in this browser only. |
| `diagnostics.html` / `.js` | Connection test page. |
| `icons/` | 16, 48 and 128 px toolbar icons. |

Every request is sent with `credentials: "include"`, `Accept: application/json` and `X-Atlassian-Token: no-check`.

## Troubleshooting

**"Couldn't update the team sheet".** Open ⚙ Settings and click **Save & test**. "Invalid token" means the token is wrong. "Returned a Google page" means the web app isn't deployed with access set to **Anyone**. Logging to Jira still works when the sheet sync fails; click **Sync now** in the Today panel to retry.


**"You're not signed in to Jira" banner.** Jira returned 401 or 403, or redirected to the Atlassian login page. Open https://newagesmb.atlassian.net, sign in, then reload the Daily Work Log tab.

**Still signed out even though Jira works in another tab.** Chrome may be blocking the session cookie for extension requests. Check `chrome://settings/cookies`. If third-party cookies are blocked, add `[*.]atlassian.net` under "Allowed to use third-party cookies". Also make sure you loaded the extension in the same Chrome profile you use for Jira.

**"XSRF check failed" when logging time.** Jira can reject POSTs that carry a `chrome-extension://` `Origin` header. When the extension sees this error, it adds one dynamic `declarativeNetRequest` rule and retries the request once. The rule removes the `Origin` header, and only on requests this extension makes (`initiatorDomains` is the extension's own ID) to `https://newagesmb.atlassian.net/rest/*`. The rule persists across browser restarts. To inspect or remove it, open the extension's service worker console from `chrome://extensions` and run:

```js
chrome.declarativeNetRequest.getDynamicRules().then(console.log)
chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] })
```

**Other error toasts.** The toast shows Jira's own message, taken from `errorMessages` and `errors`. For example, "You do not have the permission to associate a worklog to this issue" means you lack the *Work on issues* permission in that project.

**Font doesn't load.** The page loads its font from Google Fonts. An extension page's CSP only restricts scripts, so a stylesheet from fonts.googleapis.com is allowed. If you're offline, the fallback system font is used.

**Worklog shows at the wrong time.** `started` is sent in your local time with your local offset, for example `2026-09-29T09:00:00.000+0530`. Check your OS time zone.
