# Knowledge Bot

A Slack bot that answers questions using Notion FAQ pages and Claude. When it can't answer, it escalates to subject-matter experts and learns from their responses.

## Architecture

```
src/
  index.js            — Entry point: boots Slack app, Notion, periodic jobs
  config.js           — Loads secrets from .env, settings from bot-config.json
  config/
    bot-config.template.json  — Default settings (copied to bot-config.json per deployment)
    knowledge-areas.json      — Runtime state: registered knowledge areas + team rosters
  channel-handler.js  — Watches channels, classifies questions, answers or escalates
  dm-handler.js       — Handles DMs: roster management, self-registration, multi-turn flows
  llm.js              — All Claude API calls: classification, answering, synthesis, intent parsing
  notion.js           — Notion API: fetch pages, append FAQ entries, find/update blocks
  knowledge-areas.js  — CRUD for knowledge areas and team member rosters
  escalation-tracker.js — Tracks unanswered questions, synthesizes owner responses into FAQ
  answer-tracker.js   — Tracks bot answers, detects owner corrections, proposes FAQ updates
  jobs.js             — Periodic jobs: escalation synthesis, correction detection
  formatters.js       — Slack message formatting helpers
  slack-helpers.js    — Slack API utilities (channel resolution, user lookup, deduplication)
  app-home.js         — Slack App Home tab
  slash-commands.js   — /kbot slash command handler
```

## Config files

- `.env` — Secrets (Slack tokens, Anthropic key, Notion key). Gitignored.
- `src/config/bot-config.json` — Team-specific settings (channels, admin IDs, general FAQ). Gitignored. Falls back to `bot-config.template.json`.
- `src/config/knowledge-areas.json` — Runtime knowledge area state. Gitignored.
- `data/` — Runtime state files (escalations, answers, pending DMs). Gitignored.

## Common tasks

**Add a watched channel:** Set `WATCH_CHANNELS=channel1,channel2` in `.env`, or edit `watchChannels` in `bot-config.json`.

**Change the bot name:** Edit `botName` in `bot-config.json` and update `display_name` in `slack-manifest.json`.

**Add a knowledge area:** DM the bot as a lead: "Create a new knowledge area called Sales" and provide the Notion FAQ page URL. Or use `/kbot add`.

**Enable the general FAQ / Knowledge Base:** In `bot-config.json`, set `generalFaq.enabled: true` and either `generalFaq.notionPageUrl` (single page) or `generalFaq.kbRootPageUrl` (root page with sub-pages the bot will traverse).

**Add admin users for general FAQ:** Add Slack user IDs to `generalFaq.adminUserIds` in `bot-config.json`.

## Testing

```bash
npm test
```

Runs `test/smoke.js` — verifies all modules import and export expected symbols. No test framework needed.

## Key behaviors

- Bot answers questions in watched channels using Notion FAQ content
- If the FAQ partially answers, it @-mentions relevant knowledge area leads
- If a lead corrects the bot's answer, it proposes an FAQ update via DM
- Owner responses to escalations are synthesized into new FAQ entries after a 30-minute delay
- Team members are auto-discovered from substantive thread replies
- DMs support roster management, self-registration, and knowledge area creation
