# Knowledge Loop

A Slack bot that answers your team's questions using Notion FAQ pages, powered by Claude. When it doesn't know the answer, it tags the right people — then learns from their responses so it knows next time.

## Prerequisites

- A Slack workspace where you can install apps
- A Notion workspace with FAQ pages
- An [Anthropic API key](https://console.anthropic.com) (for Claude)
- A [Railway](https://railway.app) account (or any Node.js host)

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Select your workspace, switch to JSON, and paste the contents of `slack-manifest.json` from this repo
3. Click **Create**, then **Install to Workspace**

Now grab these three values:

| Credential | Where to find it |
|---|---|
| **Bot Token** (`xoxb-...`) | OAuth & Permissions → Bot User OAuth Token |
| **App-Level Token** (`xapp-...`) | Basic Information → App-Level Tokens → Generate with `connections:write` scope |
| **Signing Secret** | Basic Information → App Credentials |

### 2. Set Up Notion

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) → **New integration**
2. Name it, select your workspace, click **Submit**
3. Copy the **Internal Integration Secret** (`ntn_...`)
4. On each Notion FAQ page the bot should read: click `...` → **Connections** → add your integration

You can point the bot at a single FAQ page, or at a root page with sub-pages (like a wiki) — it'll search through all of them.

### 3. Get an Anthropic API Key

[console.anthropic.com](https://console.anthropic.com) → **API Keys** → create a key (`sk-ant-...`)

### 4. Deploy to Railway

1. Fork this repo, then go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Add these variables:

| Variable | Value |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` from step 1 |
| `SLACK_APP_TOKEN` | `xapp-...` from step 1 |
| `SLACK_SIGNING_SECRET` | Signing secret from step 1 |
| `ANTHROPIC_API_KEY` | `sk-ant-...` from step 3 |
| `NOTION_API_KEY` | `ntn_...` from step 2 |
| `WATCH_CHANNELS` | Comma-separated channel names (e.g. `general,support`) |

3. Attach a volume (Settings → Volumes) mounted at `/app/data`, then add variable `DATA_DIR=/app/data`
4. Deploy. No public URL needed — the bot connects to Slack via WebSocket.

### 5. Configure Knowledge Areas

Knowledge areas link a topic to a Notion FAQ page and a set of expert leads. Add them by:

- **DMing the bot**: "Create a new knowledge area called Sales"
- **Slash command**: `/kbot add`

For a general Knowledge Base that covers everything, add a `GENERAL_FAQ_ROOT_URL` pointing to your root Notion page — or configure it in `src/config/bot-config.json` (copy from `bot-config.template.json`). See `CLAUDE.md` for details.

## Customizing with Claude Code

This repo includes a `CLAUDE.md` file that gives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) full context about the codebase. Example prompts:

- "Add a new watched channel called #finance-questions"
- "Change the bot name to Finance Helper"
- "Set up the general FAQ to use this Notion page: https://notion.so/..."
