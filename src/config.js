import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function splitCsv(v) {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Load bot-config.json (team-specific settings)
let botConfig = {};
const BOT_CONFIG_PATH = path.join(__dirname, "config", "bot-config.json");
try {
  botConfig = require("./config/bot-config.json");
} catch {
  // Fall back to template if bot-config.json doesn't exist
  try {
    botConfig = require("./config/bot-config.template.json");
  } catch {
    botConfig = {};
  }
}

// Secrets from .env (required)
const secrets = {
  SLACK_BOT_TOKEN: requireEnv("SLACK_BOT_TOKEN"),
  SLACK_APP_TOKEN: requireEnv("SLACK_APP_TOKEN"),
  SLACK_SIGNING_SECRET: requireEnv("SLACK_SIGNING_SECRET"),
  ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),
  NOTION_API_KEY: requireEnv("NOTION_API_KEY"),
};

// .env overrides for backward compat
const envWatchChannels = process.env.WATCH_CHANNELS
  ? splitCsv(process.env.WATCH_CHANNELS)
  : null;

const config = Object.freeze({
  // Bot identity
  botName: botConfig.botName || "Knowledge Bot",
  slashCommand: botConfig.slashCommand || "/kbot",

  // Channels to watch — .env overrides bot-config.json
  watchChannels: envWatchChannels || botConfig.watchChannels || [],

  // Display settings
  showEvidence: process.env.SHOW_EVIDENCE
    ? process.env.SHOW_EVIDENCE.toLowerCase() === "true"
    : botConfig.showEvidence ?? false,

  // General FAQ
  generalFaq: Object.freeze({
    enabled: botConfig.generalFaq?.enabled ?? false,
    notionPageUrl: botConfig.generalFaq?.notionPageUrl || "",
    kbRootPageUrl: botConfig.generalFaq?.kbRootPageUrl || "",
    adminUserIds: Object.freeze([...(botConfig.generalFaq?.adminUserIds || [])]),
  }),

  // Feature flags
  features: Object.freeze({
    autoDiscovery: botConfig.features?.autoDiscovery ?? true,
    faqCorrection: botConfig.features?.faqCorrection ?? true,
  }),

  // Model configuration
  claudeModel: (process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5").trim(),
  claudeSmartModel: (process.env.CLAUDE_SMART_MODEL ?? "claude-opus-4-6").trim(),

  // Timing configuration
  escalationCheckIntervalMs: Number(process.env.ESCALATION_CHECK_INTERVAL_MS ?? 5 * 60 * 1000),
  synthesisDelayMs: Number(process.env.SYNTHESIS_DELAY_MS ?? 30 * 60 * 1000),
  correctionCheckDelayMs: Number(process.env.CORRECTION_CHECK_DELAY_MS ?? 10 * 1000),
  notionCacheTtlMs: Number(process.env.NOTION_CACHE_TTL_MS ?? 10 * 60 * 1000),
  kbHierarchyCacheTtlMs: Number(process.env.KB_HIERARCHY_CACHE_TTL_MS ?? 30 * 60 * 1000),
  descriptionUpdateThrottleMs: 7 * 24 * 60 * 60 * 1000,

  // Data directory
  dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "data"),

  // Secrets — passed through from .env
  ...secrets,
});

export default config;
