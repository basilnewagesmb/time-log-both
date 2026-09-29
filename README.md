# Daily Work Log

A Chrome extension for logging time to Jira Cloud (`newagesmb.atlassian.net`) from a simple daily timesheet page. It uses the Jira session you're already signed in to in Chrome, so there's no API token to set up and no server.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Daily Work Log**.
5. Make sure you're signed in to https://newagesmb.atlassian.net in the same Chrome profile, then click the icon.

To update later: `git pull`, then click the reload icon on the extension's card in `chrome://extensions`.

To send your daily hours to the team sheet, click ⚙ in the extension and paste the web app URL and token from the sheet owner. Setting up the sheet and the 5 PM Chat reminder is covered in [sheets/README.md](sheets/README.md).

See [extension/README.md](extension/README.md) for how it works and for troubleshooting.
