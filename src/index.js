import "dotenv/config";

import bolt from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";

import config from "./config.js";
import { initNotion, fetchPageContent, fetchKbHierarchy } from "./notion.js";
import { loadKnowledgeAreas, getAllKnowledgeAreas } from "./knowledge-areas.js";
import { loadEscalations, cleanupOldEscalations } from "./escalation-tracker.js";
import { loadFaqAnswers, cleanupOldFaqAnswers } from "./answer-tracker.js";
import { resolveWatchChannels, initSlackIdentity } from "./slack-helpers.js";
import { registerAppHomeHandlers } from "./app-home.js";
import { registerSlashCommand } from "./slash-commands.js";
import { registerDmHandler, loadPendingDms } from "./dm-handler.js";
import { registerChannelHandler } from "./channel-handler.js";
import { checkPendingEscalations, checkPendingCorrections, runPeriodicChecks } from "./jobs.js";

const { App } = bolt;

const app = new App({
  token: config.SLACK_BOT_TOKEN,
  signingSecret: config.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: config.SLACK_APP_TOKEN,
});

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// Notion content cache
const notionCache = new Map();

async function getNotionContent(pageId) {
  const cached = notionCache.get(pageId);
  if (cached && Date.now() - cached.fetchedAt < config.notionCacheTtlMs) {
    return cached.content;
  }
  try {
    const content = await fetchPageContent(pageId, app.logger);
    notionCache.set(pageId, { content, fetchedAt: Date.now() });
    return content;
  } catch (err) {
    app.logger.error(`[Notion] Failed to fetch page ${pageId}: ${err?.message ?? err}`);
    if (cached?.content) return cached.content;
    return "";
  }
}

// KB hierarchy cache (separate from page content cache)
const kbHierarchyCache = { data: null, fetchedAt: 0 };

async function getKbHierarchy() {
  const rootUrl = config.generalFaq.kbRootPageUrl;
  if (!rootUrl) return [];

  const now = Date.now();
  if (kbHierarchyCache.data && now - kbHierarchyCache.fetchedAt < config.kbHierarchyCacheTtlMs) {
    return kbHierarchyCache.data;
  }

  try {
    const hierarchy = await fetchKbHierarchy(rootUrl, app.logger);
    kbHierarchyCache.data = hierarchy;
    kbHierarchyCache.fetchedAt = now;
    return hierarchy;
  } catch (err) {
    app.logger.error(`[KB] Failed to fetch hierarchy: ${err?.message ?? err}`);
    // Return stale data if available
    if (kbHierarchyCache.data) return kbHierarchyCache.data;
    return [];
  }
}

// Shared context passed to all modules
const ctx = {
  config,
  anthropic,
  notionCache,
  watchChannelIds: new Set(),
  channelIdToName: new Map(),
  botUserId: null,
  getNotionContent,
  getKbHierarchy,
  logger: app.logger,
};

async function bootstrap() {
  app.logger.info(`[Bootstrap] Initializing Notion client...`);
  initNotion(config.NOTION_API_KEY);

  app.logger.info(`[Bootstrap] Loading knowledge areas...`);
  await loadKnowledgeAreas(app.logger);
  app.logger.info(`[Bootstrap] Loaded ${getAllKnowledgeAreas().length} knowledge area(s)`);

  app.logger.info(`[Bootstrap] Loading escalation tracker...`);
  await loadEscalations();

  app.logger.info(`[Bootstrap] Loading FAQ answer tracker...`);
  await loadFaqAnswers(app.logger);

  loadPendingDms(config.dataDir);
  app.logger.info(`[Bootstrap] Pending DM actions loaded`);

  // Resolve Slack identity and channels
  ctx.botUserId = await initSlackIdentity(app.client);
  const resolved = await resolveWatchChannels(app.client, config.watchChannels, app.logger);
  ctx.watchChannelIds = resolved.channelIds;
  ctx.channelIdToName = resolved.idToName;

  // Register all handlers
  registerAppHomeHandlers(app, app.logger);
  registerSlashCommand(app, ctx);
  registerDmHandler(app, ctx);
  registerChannelHandler(app, ctx);

  app.logger.info(`Watching channels: ${config.watchChannels.join(", ")}`);
  app.logger.info(`Resolved watchChannelIds: ${[...ctx.watchChannelIds].join(", ") || "(none)"}`);
  app.logger.info(`Knowledge areas configured: ${getAllKnowledgeAreas().length}`);
  app.logger.info(`Claude model: ${config.claudeModel}`);

  const port = Number(process.env.PORT ?? 3000);
  await app.start(port);
  app.logger.info(`Bot started (Socket Mode).`);

  // ─── Periodic jobs ───────────────────────────────────────────────────────

  // Refresh channel resolutions hourly
  setInterval(async () => {
    try {
      const refreshed = await resolveWatchChannels(app.client, config.watchChannels, app.logger);
      ctx.watchChannelIds = refreshed.channelIds;
      ctx.channelIdToName = refreshed.idToName;
      app.logger.info("Refreshed Slack channel cache.");
    } catch (e) {
      app.logger.warn(`Failed refreshing channel cache: ${e?.message ?? e}`);
    }
  }, 60 * 60 * 1000).unref();

  // Escalation + correction checks
  setInterval(async () => {
    try {
      await runPeriodicChecks(app, ctx);
      const cleaned = await cleanupOldEscalations();
      if (cleaned > 0) app.logger.info(`[Escalation] Cleaned up ${cleaned} old escalation(s)`);
      const cleanedAnswers = await cleanupOldFaqAnswers(30, app.logger);
      if (cleanedAnswers > 0) app.logger.info(`[AnswerTracker] Cleaned up ${cleanedAnswers} old FAQ answer(s)`);
    } catch (e) {
      app.logger.error(`[Periodic] Failed running periodic checks: ${e?.message ?? e}`);
    }
  }, config.escalationCheckIntervalMs).unref();

  // Initial check shortly after startup
  setTimeout(async () => {
    app.logger.info(`[Periodic] Running initial escalation check`);
    await checkPendingEscalations(app, ctx).catch((e) => {
      app.logger.error(`[Escalation] Initial check failed: ${e?.message ?? e}`);
    });
    app.logger.info(`[Periodic] Running initial correction check`);
    await checkPendingCorrections(app, ctx).catch((e) => {
      app.logger.error(`[Correction] Initial check failed: ${e?.message ?? e}`);
    });
  }, 30000).unref();
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
