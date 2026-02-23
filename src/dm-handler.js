import fs from "node:fs";
import path from "node:path";
import { alreadySeen, resolveUsersByName, sendDmToUser } from "./slack-helpers.js";
import { formatRosterArea } from "./formatters.js";
import { extractPageId, updateFaqBlock, findBlockByContent, addCommentToBlock } from "./notion.js";
import {
  getAllKnowledgeAreas,
  getKnowledgeAreaById,
  getKnowledgeAreaByName,
  addKnowledgeArea,
  isLeadForAnyArea,
  isTeamMemberForArea,
  addTeamMember,
  removeMember,
  promoteToLead,
  demoteToTeamMember,
  updateMemberDescription,
  getMember,
  getLeadUserIds,
} from "./knowledge-areas.js";
import {
  parseDmIntent,
  evolveExpertiseDescription,
  reviseSuggestedUpdate,
} from "./llm.js";

// ─── Pending DM conversation state for multi-turn flows ─────────────────────
const pendingDmActions = new Map();
const PENDING_DM_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

let DATA_DIR = "";
let PENDING_DMS_PATH = "";

function initPaths(dataDir) {
  DATA_DIR = dataDir;
  PENDING_DMS_PATH = path.join(DATA_DIR, "pending-dms.json");
}

export function loadPendingDms(dataDir) {
  initPaths(dataDir);
  try {
    if (fs.existsSync(PENDING_DMS_PATH)) {
      const entries = JSON.parse(fs.readFileSync(PENDING_DMS_PATH, "utf-8"));
      const now = Date.now();
      for (const [userId, data] of entries) {
        if (data.expiresAt && data.expiresAt > now) {
          pendingDmActions.set(userId, data);
        }
      }
    }
  } catch { /* start fresh */ }
}

function savePendingDms() {
  try {
    fs.mkdirSync(path.dirname(PENDING_DMS_PATH), { recursive: true });
    fs.writeFileSync(PENDING_DMS_PATH, JSON.stringify([...pendingDmActions.entries()], null, 2));
  } catch { /* best-effort */ }
}

function getPendingDm(userId) {
  const pending = pendingDmActions.get(userId);
  if (!pending) return null;
  if (Date.now() > pending.expiresAt) {
    pendingDmActions.delete(userId);
    savePendingDms();
    return null;
  }
  return pending;
}

export function setPendingDm(userId, data) {
  pendingDmActions.set(userId, { ...data, expiresAt: Date.now() + PENDING_DM_EXPIRY_MS });
  savePendingDms();
}

function clearPendingDm(userId) {
  pendingDmActions.delete(userId);
  savePendingDms();
}

// Tracks correction IDs that have already been applied to Notion,
// so a second lead approving the same correction doesn't double-write.
const processedCorrections = new Set();

export function clearPendingDmsForCorrection(correctionId) {
  let changed = false;
  for (const [userId, pending] of pendingDmActions) {
    if (
      pending.intent === "faq_correction_approval" &&
      pending.partialData?.correctionId === correctionId
    ) {
      pendingDmActions.delete(userId);
      changed = true;
    }
  }
  if (changed) savePendingDms();
}

// ─── DM intent handlers ─────────────────────────────────────────────────────

async function handleDmViewRoster(event, client, result) {
  const areaId = result.matched_knowledge_area_id;
  if (areaId) {
    const area = getKnowledgeAreaById(areaId);
    if (area) {
      await client.chat.postMessage({
        channel: event.channel,
        text: `${result.response_message}\n\n${formatRosterArea(area)}`,
        mrkdwn: true,
      });
      return;
    }
  }
  const areas = getAllKnowledgeAreas();
  if (areas.length === 0) {
    await client.chat.postMessage({ channel: event.channel, text: "No knowledge areas configured yet.", mrkdwn: true });
    return;
  }
  const blocks = areas.map(formatRosterArea);
  await client.chat.postMessage({
    channel: event.channel,
    text: `${result.response_message}\n\n${blocks.join("\n\n———\n\n")}`,
    mrkdwn: true,
  });
}

async function handleDmModifyRoster(event, client, result, logger) {
  if (!isLeadForAnyArea(event.user)) {
    await client.chat.postMessage({
      channel: event.channel,
      text: "Only knowledge area leads can modify the roster. You can self-register by telling me about your role and expertise!",
      mrkdwn: true,
    });
    return;
  }

  const action = result.action;
  const areaId = result.matched_knowledge_area_id;
  if (!areaId) {
    await client.chat.postMessage({
      channel: event.channel,
      text: "I couldn't figure out which knowledge area you're referring to. Could you specify the area name?",
      mrkdwn: true,
    });
    return;
  }

  const area = getKnowledgeAreaById(areaId);
  if (!area) {
    await client.chat.postMessage({
      channel: event.channel,
      text: `I couldn't find a knowledge area with ID "${areaId}". Try specifying the area name.`,
      mrkdwn: true,
    });
    return;
  }

  let targetUserIds = [...(result.target_user_mentions || [])];
  if (targetUserIds.length === 0 && (result.target_user_names || []).length > 0) {
    const resolved = await resolveUsersByName(client, result.target_user_names, logger);
    targetUserIds = resolved;
  }

  if (targetUserIds.length === 0) {
    await client.chat.postMessage({
      channel: event.channel,
      text: "I couldn't identify who you're referring to. Try mentioning them with @ or give me their full name.",
      mrkdwn: true,
    });
    return;
  }

  const confirmations = [];

  for (const userId of targetUserIds) {
    try {
      switch (action) {
        case "add_member": {
          await addTeamMember(areaId, userId, result.member_description || "", `added-by:${event.user}`, logger);
          confirmations.push(`Added <@${userId}> to *${area.name}*${result.member_description ? ` _(${result.member_description})_` : ""}`);
          break;
        }
        case "remove_member": {
          const removed = await removeMember(areaId, userId, logger);
          confirmations.push(removed ? `Removed <@${userId}> from *${area.name}*` : `<@${userId}> wasn't a member of *${area.name}*`);
          break;
        }
        case "promote": {
          await promoteToLead(areaId, userId, logger);
          confirmations.push(`Promoted <@${userId}> to lead for *${area.name}*`);
          break;
        }
        case "demote": {
          await demoteToTeamMember(areaId, userId, logger);
          confirmations.push(`Demoted <@${userId}> from lead to team member on *${area.name}*`);
          break;
        }
        case "update_description": {
          if (result.member_description) {
            await updateMemberDescription(areaId, userId, result.member_description, logger);
            confirmations.push(`Updated <@${userId}>'s description on *${area.name}* to: _${result.member_description}_`);
          } else {
            confirmations.push(`No description provided for <@${userId}>`);
          }
          break;
        }
        default:
          confirmations.push(`I didn't understand the action for <@${userId}>.`);
      }
    } catch (err) {
      logger.warn(`[DM] Roster modify error for ${userId}: ${err?.message ?? err}`);
      confirmations.push(`Error for <@${userId}>: ${err?.message ?? "Unknown error"}`);
    }
  }

  await client.chat.postMessage({
    channel: event.channel,
    text: `${result.response_message}\n\n${confirmations.join("\n")}`,
    mrkdwn: true,
  });
}

async function handleDmAddKnowledgeArea(event, client, result, logger) {
  if (!isLeadForAnyArea(event.user)) {
    await client.chat.postMessage({
      channel: event.channel,
      text: "Only knowledge area leads can add new knowledge areas. You can self-register by telling me about your role and expertise!",
      mrkdwn: true,
    });
    return;
  }

  const name = result.new_area_name?.trim();
  const notionUrl = result.new_area_notion_url?.trim();
  const description = result.new_area_description?.trim() || "";
  const keywords = (result.new_area_keywords || []).filter(Boolean);
  let leadUserIds = [...(result.new_area_lead_mentions || [])];

  if (!name) {
    await client.chat.postMessage({
      channel: event.channel,
      text: "I need at least a name for the new knowledge area. What should it be called?",
      mrkdwn: true,
    });
    return;
  }

  if (getKnowledgeAreaByName(name)) {
    await client.chat.postMessage({
      channel: event.channel,
      text: `A knowledge area called "${name}" already exists. Did you mean to modify it instead?`,
      mrkdwn: true,
    });
    return;
  }

  if (!notionUrl) {
    setPendingDm(event.user, {
      intent: "add_knowledge_area",
      partialData: { name, description, keywords, leadUserIds, leadNames: result.new_area_lead_names || [] },
    });
    await client.chat.postMessage({
      channel: event.channel,
      text: `Got it — I'll set up *${name}*. What's the Notion page URL for this area's FAQ?`,
      mrkdwn: true,
    });
    return;
  }

  if (!extractPageId(notionUrl)) {
    setPendingDm(event.user, {
      intent: "add_knowledge_area",
      partialData: { name, description, keywords, leadUserIds, leadNames: result.new_area_lead_names || [] },
    });
    await client.chat.postMessage({
      channel: event.channel,
      text: "That doesn't look like a valid Notion page URL. Could you paste the full URL?",
      mrkdwn: true,
    });
    return;
  }

  if (leadUserIds.length === 0 && (result.new_area_lead_names || []).length > 0) {
    leadUserIds = await resolveUsersByName(client, result.new_area_lead_names, logger);
  }

  const area = await addKnowledgeArea({ name, description, notionPageId: notionUrl, ownerUserIds: leadUserIds, keywords }, logger);
  const leadsList = leadUserIds.length ? leadUserIds.map((id) => `<@${id}>`).join(", ") : "_No leads set yet_";

  await client.chat.postMessage({
    channel: event.channel,
    text: `Done! Created knowledge area *${area.name}* (ID: \`${area.id}\`)\nLeads: ${leadsList}${description ? `\n_${description}_` : ""}${keywords.length ? `\nKeywords: ${keywords.join(", ")}` : ""}`,
    mrkdwn: true,
  });
}

async function handleDmSelfRegistration(event, client, text, result, ctx) {
  const { config, anthropic } = ctx;
  const logger = ctx.logger;
  const addedAreas = [];
  const updatedAreas = [];

  for (const areaId of result.matched_self_reg_area_ids || []) {
    const area = getKnowledgeAreaById(areaId);
    if (!area) {
      logger.warn(`[DM] Matched area ID "${areaId}" not found, skipping`);
      continue;
    }

    if (isTeamMemberForArea(event.user, areaId)) {
      if (result.expertise_description) {
        const member = getMember(areaId, event.user);
        if (member) {
          try {
            const evolveResult = await evolveExpertiseDescription(anthropic, config.claudeSmartModel, member.description || "", text, area.name);
            if (evolveResult.changed && evolveResult.updated_description) {
              await updateMemberDescription(areaId, event.user, evolveResult.updated_description, logger);
              logger.info(`[DM] Updated description for <@${event.user}> in "${area.name}": "${evolveResult.updated_description}"`);
            }
            updatedAreas.push(area.name);
          } catch (err) {
            logger.warn(`[DM] Failed to evolve description: ${err?.message ?? err}`);
            await updateMemberDescription(areaId, event.user, result.expertise_description, logger);
            updatedAreas.push(area.name);
          }
        }
      }
      continue;
    }

    await addTeamMember(areaId, event.user, result.expertise_description || "", "self-registered", logger);
    addedAreas.push(area.name);
    logger.info(`[DM] Added <@${event.user}> as team member for "${area.name}" via DM self-registration`);
  }

  if (addedAreas.length > 0 || updatedAreas.length > 0) {
    let replyText = result.response_message;

    await client.chat.postMessage({ channel: event.channel, text: replyText, mrkdwn: true });
  } else {
    await client.chat.postMessage({
      channel: event.channel,
      text: result.response_message || "I wasn't able to match your expertise to a specific knowledge area. Could you be more specific about which area you work on?",
      mrkdwn: true,
    });
  }
}

/**
 * Continue a pending multi-turn DM conversation.
 */
async function continuePendingDm(event, client, text, pending, ctx) {
  const { anthropic, config, notionCache } = ctx;
  const logger = ctx.logger;

  if (pending.intent === "add_knowledge_area") {
    const { name, description, keywords, leadUserIds: existingLeadIds, leadNames } = pending.partialData;

    const urlMatch = text.match(/https?:\/\/[^\s>]+|[a-f0-9]{32}/i);
    if (!urlMatch) {
      if (/\b(cancel|nevermind|never mind|stop|abort)\b/i.test(text)) {
        clearPendingDm(event.user);
        await client.chat.postMessage({ channel: event.channel, text: "No problem, cancelled!", mrkdwn: true });
        return;
      }
      await client.chat.postMessage({
        channel: event.channel,
        text: "I need a Notion page URL to create this knowledge area. Paste the URL, or say \"cancel\" to abort.",
        mrkdwn: true,
      });
      return;
    }

    const notionUrl = urlMatch[0];
    if (!extractPageId(notionUrl)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: "That doesn't look like a valid Notion page URL. Could you paste the full URL? Or say \"cancel\" to abort.",
        mrkdwn: true,
      });
      return;
    }

    clearPendingDm(event.user);

    let leadUserIds = existingLeadIds || [];
    if (leadUserIds.length === 0 && (leadNames || []).length > 0) {
      leadUserIds = await resolveUsersByName(client, leadNames, logger);
    }

    const area = await addKnowledgeArea({ name, description, notionPageId: notionUrl, ownerUserIds: leadUserIds, keywords }, logger);
    const leadsList = leadUserIds.length ? leadUserIds.map((id) => `<@${id}>`).join(", ") : "_No leads set yet_";

    await client.chat.postMessage({
      channel: event.channel,
      text: `Done! Created knowledge area *${area.name}* (ID: \`${area.id}\`)\nLeads: ${leadsList}${description ? `\n_${description}_` : ""}${keywords.length ? `\nKeywords: ${keywords.join(", ")}` : ""}`,
      mrkdwn: true,
    });
    return;
  }

  if (pending.intent === "faq_correction_approval") {
    const {
      correctionId,
      blockId,
      notionPageId,
      suggestedUpdate,
      originalQuestion,
      areaName,
    } = pending.partialData;

    if (processedCorrections.has(correctionId)) {
      logger.info(`[Correction] Correction ${correctionId} already processed, notifying <@${event.user}>`);
      clearPendingDm(event.user);
      await client.chat.postMessage({
        channel: event.channel,
        text: "This FAQ update was already applied by another lead — no action needed!",
        mrkdwn: true,
      });
      return;
    }

    const lower = text.toLowerCase().trim();
    const isApproval = /^(yes|yep|yeah|yea|sure|approved|lgtm|go for it|do it|go ahead|ship it|looks good|ok|okay)\b/i.test(lower);
    const isRejection = /^(no|nope|cancel|nevermind|never mind|don't update|stop|reject|skip)\b/i.test(lower);

    if (isApproval) {
      logger.info(`[Correction] <@${event.user}> approved correction ${correctionId} for "${areaName}"`);

      if (!blockId) {
        logger.warn(`[Correction] No blockId for correction ${correctionId} — cannot auto-update Notion`);
        clearPendingDm(event.user);
        clearPendingDmsForCorrection(correctionId);
        await client.chat.postMessage({
          channel: event.channel,
          text: "I couldn't locate the specific FAQ block in Notion, so I can't update it automatically. You'll need to edit it manually. Sorry about that!",
          mrkdwn: true,
        });
        return;
      }

      try {
        logger.info(`[Correction] Updating Notion block ${blockId.slice(0, 8)}... for correction ${correctionId}`);
        const blockUrl = await updateFaqBlock(blockId, suggestedUpdate, logger);

        logger.info(`[Correction] Invalidating cache for page ${notionPageId?.slice(0, 8) ?? "unknown"}`);
        notionCache.delete(notionPageId);

        // Also invalidate cache for the sub-page if it differs from notionPageId
        const subPageId = pending.partialData.subPageId;
        if (subPageId && subPageId !== notionPageId) {
          logger.info(`[Correction] Invalidating cache for KB sub-page ${subPageId.slice(0, 8)}...`);
          notionCache.delete(subPageId);
        }

        // Leave an audit comment on the updated block
        try {
          logger.info(`[Correction] Adding audit comment to block ${blockId.slice(0, 8)}...`);
          await addCommentToBlock(
            blockId,
            `Updated by bot based on correction from a Slack thread.\nOriginal question: ${originalQuestion}`,
            logger
          );
          logger.info(`[Correction] Audit comment added successfully`);
        } catch (commentErr) {
          logger.warn(`[Correction] Failed to add Notion comment (non-blocking): ${commentErr?.message ?? commentErr}`);
        }

        processedCorrections.add(correctionId);
        clearPendingDm(event.user);
        clearPendingDmsForCorrection(correctionId);
        logger.info(`[Correction] Correction ${correctionId} applied successfully — ${blockUrl}`);

        await client.chat.postMessage({
          channel: event.channel,
          text: `Done! I've updated the *${areaName}* FAQ entry.\n\n<${blockUrl}|View in Notion>`,
          mrkdwn: true,
        });
      } catch (err) {
        logger.error(`[Correction] Error updating Notion block: ${err?.message ?? err}`);
        await client.chat.postMessage({
          channel: event.channel,
          text: `I ran into an error updating the FAQ in Notion: ${err?.message ?? "unknown error"}. You may need to edit it manually.`,
          mrkdwn: true,
        });
        clearPendingDm(event.user);
      }
      return;
    }

    if (isRejection) {
      logger.info(`[Correction] <@${event.user}> rejected correction ${correctionId} for "${areaName}"`);
      clearPendingDm(event.user);
      await client.chat.postMessage({
        channel: event.channel,
        text: "Got it, I won't update the FAQ.",
        mrkdwn: true,
      });
      return;
    }

    // Treat anything else as revision feedback
    try {
      const revised = await reviseSuggestedUpdate(anthropic, config.claudeModel, {
        originalQuestion,
        currentSuggestion: suggestedUpdate,
        feedback: text,
      });

      if (!revised) {
        await client.chat.postMessage({
          channel: event.channel,
          text: "I couldn't generate a revision from that feedback. Could you try rephrasing?",
          mrkdwn: true,
        });
        return;
      }

      setPendingDm(event.user, {
        intent: "faq_correction_approval",
        partialData: {
          ...pending.partialData,
          suggestedUpdate: revised,
        },
      });

      await client.chat.postMessage({
        channel: event.channel,
        text: `Here's the revised version:\n\n${revised}\n\nShould I go ahead with this? Reply *yes* to approve, or tell me what else to change.`,
        mrkdwn: true,
      });
    } catch (err) {
      logger.error(`[Correction] Error revising suggested update: ${err?.message ?? err}`);
      await client.chat.postMessage({
        channel: event.channel,
        text: "Sorry, I hit an error trying to revise the suggestion. Could you try again?",
        mrkdwn: true,
      });
    }
    return;
  }

  // Unknown pending intent — clear and re-process
  clearPendingDm(event.user);
}

// ─── Main DM handler registration ───────────────────────────────────────────

export function registerDmHandler(app, ctx) {
  const { config, anthropic } = ctx;

  app.event("message", async ({ event, client, logger }) => {
    try {
      if (event.channel_type !== "im") return;
      if (event.subtype) return;
      if (event.bot_id) return;
      if (ctx.botUserId && event.user === ctx.botUserId) return;

      const text = (event.text ?? "").trim();
      if (!text) return;

      const dedupeKey = `dm:${event.channel}:${event.ts}`;
      if (alreadySeen(dedupeKey)) return;

      logger.info(`[DM] Received DM from <@${event.user}>: "${text.substring(0, 100)}${text.length > 100 ? "..." : ""}"`);

      const handlerCtx = { ...ctx, logger };

      // Check for pending multi-turn conversation first
      const pending = getPendingDm(event.user);
      if (pending) {
        logger.info(`[DM] Continuing pending ${pending.intent} flow for <@${event.user}>`);
        await continuePendingDm(event, client, text, pending, handlerCtx);
        return;
      }

      const areas = getAllKnowledgeAreas();
      const senderIsLead = !!isLeadForAnyArea(event.user);

      const result = await parseDmIntent(anthropic, config.claudeSmartModel, text, areas, senderIsLead);
      logger.info(`[DM] Intent: ${result.intent}, action: ${result.action}, area: ${result.matched_knowledge_area_id}`);

      switch (result.intent) {
        case "view_roster":
          await handleDmViewRoster(event, client, result);
          break;

        case "modify_roster":
          await handleDmModifyRoster(event, client, result, logger);
          break;

        case "add_knowledge_area":
          await handleDmAddKnowledgeArea(event, client, result, logger);
          break;

        case "self_registration":
          await handleDmSelfRegistration(event, client, text, result, handlerCtx);
          break;

        case "general":
        default: {
          const helpText = senderIsLead
            ? `Here's what I can do via DM:\n• *Show the roster* — "Show me the roster" or "Who's on the engineering team?"\n• *Add/remove team members* — "Add @person to Engineering" or "Remove @person from Support"\n• *Promote/demote* — "Promote @person to lead for Engineering"\n• *Add a knowledge area* — "Create a new knowledge area called Platform"\n• *Self-register* — Tell me about your role and expertise\n\nJust ask naturally!`
            : `Here's what I can do via DM:\n• *Show the roster* — "Show me the roster" or "Who's on the engineering team?"\n• *Self-register* — Tell me about your role and expertise to get added to a team\n\nJust ask naturally!`;
          await client.chat.postMessage({
            channel: event.channel,
            text: result.response_message || helpText,
            mrkdwn: true,
          });
          break;
        }
      }
    } catch (err) {
      logger.error(`[DM] Error handling DM: ${err?.message ?? err}`);
      logger.error(err);
      try {
        await client.chat.postMessage({
          channel: event.channel,
          text: "Sorry, I hit an error processing your message. Please try again!",
        });
      } catch (_) {
        // Ignore secondary errors
      }
    }
  });
}
