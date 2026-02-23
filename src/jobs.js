import {
  getEscalationsReadyToSynthesize,
  markEscalationComplete,
  markEscalationSkipped,
  cleanupOldEscalations,
} from "./escalation-tracker.js";
import {
  getAnswersReadyToProcess,
  markAnswerCorrected,
  markAnswerProcessed,
  cleanupOldFaqAnswers,
} from "./answer-tracker.js";
import {
  getKnowledgeAreaById,
  getLeadUserIds,
} from "./knowledge-areas.js";
import {
  synthesizeFaqEntry,
  checkResponsesSubstantive,
  checkIfCorrection,
} from "./llm.js";
import {
  appendFaqEntry,
  analyzePageStructure,
  extractPageId,
  findBlockByContent,
} from "./notion.js";
import { sendDmToUser } from "./slack-helpers.js";
import { setPendingDm } from "./dm-handler.js";

const GENERAL_FAQ_AREA_ID = "general-faq";

export async function checkPendingEscalations(app, ctx) {
  const { config, anthropic, notionCache } = ctx;
  const logger = app.logger;

  const readyToSynthesize = getEscalationsReadyToSynthesize();

  if (readyToSynthesize.length > 0) {
    logger.info(`[Escalation] Found ${readyToSynthesize.length} escalation(s) ready to synthesize`);
  }

  for (const escalation of readyToSynthesize) {
    logger.info(`[Escalation] Processing escalation ${escalation.id}`);
    try {
      const isGeneralFaq = escalation.productAreaId === GENERAL_FAQ_AREA_ID;
      let notionPageId;
      let areaName;
      let responderUserIds;

      if (isGeneralFaq) {
        notionPageId = config.generalFaq.notionPageUrl;
        areaName = "General FAQ";
        responderUserIds = [...config.generalFaq.adminUserIds];
      } else {
        const area = getKnowledgeAreaById(escalation.productAreaId);
        if (!area) {
          await markEscalationSkipped(escalation.id, "knowledge_area_deleted");
          continue;
        }
        notionPageId = area.notionPageId;
        areaName = area.name;
        responderUserIds = area.ownerUserIds;
      }

      let formatStyle = null;
      try {
        formatStyle = await analyzePageStructure(notionPageId, logger);
      } catch (err) {
        logger.warn(`[Escalation] Failed to analyze FAQ structure for "${areaName}": ${err?.message ?? err}`);
      }

      const res = await app.client.conversations.replies({
        channel: escalation.channel,
        ts: escalation.threadTs,
        limit: 50,
      });

      const messages = res.messages ?? [];

      const ownerResponses = messages
        .filter((m) => {
          if (!m.user || !m.text) return false;
          if (m.ts <= escalation.messageTs) return false;
          if (m.bot_id) return false;
          return responderUserIds.includes(m.user);
        })
        .map((m) => m.text);

      if (ownerResponses.length === 0) {
        await markEscalationSkipped(escalation.id, "no_responses_found");
        continue;
      }

      const substantiveCheck = await checkResponsesSubstantive(anthropic, config.claudeModel, escalation.originalQuestion, ownerResponses);

      if (!substantiveCheck.has_substantive_answer) {
        await markEscalationSkipped(escalation.id, "non_substantive_responses");
        continue;
      }

      const synthesis = await synthesizeFaqEntry(anthropic, config.claudeModel, escalation.originalQuestion, ownerResponses, formatStyle);

      if (!synthesis.should_add_to_faq) {
        if (!isGeneralFaq) {
          await app.client.chat.postMessage({
            channel: escalation.channel,
            thread_ts: escalation.threadTs,
            text: `Thanks for the responses! I've noted this but it doesn't seem like a common enough question to add to the FAQ.`,
            mrkdwn: true,
          });
        }
        await markEscalationComplete(escalation.id);
        continue;
      }

      const faqUrl = await appendFaqEntry(
        notionPageId,
        synthesis.question,
        synthesis.answer,
        formatStyle,
        logger
      );

      notionCache.delete(notionPageId);

      if (isGeneralFaq) {
        await app.client.chat.postMessage({
          channel: escalation.channel,
          thread_ts: escalation.threadTs,
          text: `I've added this to the *General FAQ*:\n\n*Q:* ${synthesis.question}\n\n<${faqUrl}|View in Notion>`,
          mrkdwn: true,
        });
      } else {
        const ownerPings = escalation.ownerUserIds.map((id) => `<@${id}>`).join(" ");
        await app.client.chat.postMessage({
          channel: escalation.channel,
          thread_ts: escalation.threadTs,
          text: `${ownerPings} Thanks for the responses! I've updated the *${areaName} FAQ* with a new entry:\n\n*Q:* ${synthesis.question}\n\n<${faqUrl}|View in Notion>`,
          mrkdwn: true,
        });
      }

      await markEscalationComplete(escalation.id, faqUrl);
      logger.info(`[Escalation] Successfully updated FAQ for escalation ${escalation.id}`);
    } catch (err) {
      logger.error(`[Escalation] Error processing escalation ${escalation.id}: ${err?.message ?? err}`);
    }
  }
}

export async function checkPendingCorrections(app, ctx) {
  const { config, anthropic } = ctx;
  const logger = app.logger;

  const answersToProcess = getAnswersReadyToProcess();

  if (answersToProcess.length > 0) {
    logger.info(`[Correction] Found ${answersToProcess.length} answer(s) ready to process`);
  }

  for (const trackedAnswer of answersToProcess) {
    try {
      const isGeneralFaq = trackedAnswer.productAreaId === GENERAL_FAQ_AREA_ID;
      let correctionOwnerIds;
      let areaName;

      if (isGeneralFaq) {
        correctionOwnerIds = [...config.generalFaq.adminUserIds];
        areaName = "General FAQ";
      } else {
        const area = getKnowledgeAreaById(trackedAnswer.productAreaId);
        if (!area) {
          await markAnswerProcessed(trackedAnswer.id, { reason: "knowledge_area_deleted" }, logger);
          continue;
        }
        correctionOwnerIds = area.ownerUserIds;
        areaName = area.name;
      }

      const res = await app.client.conversations.replies({
        channel: trackedAnswer.channel,
        ts: trackedAnswer.threadTs,
        limit: 100,
      });

      const messages = res.messages ?? [];

      const ownerReplies = messages
        .filter((m) => {
          if (!m.user || !m.text) return false;
          if (m.ts <= trackedAnswer.messageTs) return false;
          if (m.bot_id) return false;
          return correctionOwnerIds.includes(m.user);
        })
        .map((m) => ({ userId: m.user, text: m.text }));

      if (ownerReplies.length === 0) {
        await markAnswerProcessed(trackedAnswer.id, { reason: "no_owner_replies_found" }, logger);
        continue;
      }

      const correctionResult = await checkIfCorrection(anthropic, config.claudeModel, {
        originalQuestion: trackedAnswer.originalQuestion,
        botAnswer: trackedAnswer.botAnswer,
        evidence: trackedAnswer.evidence,
        ownerReplies,
      });

      if (correctionResult.is_correction) {
        logger.info(`[Correction] Correction detected for answer ${trackedAnswer.id}`);

        const channelName = ctx.channelIdToName.get(trackedAnswer.channel) || null;

        await handleFaqCorrection({
          app,
          ctx,
          trackedAnswer,
          correctionResult,
          channelName,
          areaName,
          correctionOwnerIds,
          logger,
        });

        const respondingOwnerIds = [...new Set(ownerReplies.map((r) => r.userId))];
        await markAnswerCorrected(trackedAnswer.id, {
          correctedBy: respondingOwnerIds,
          correctedContent: correctionResult.corrected_content,
          suggestedUpdate: correctionResult.suggested_update,
          rationale: correctionResult.rationale,
        }, logger);
      } else {
        await markAnswerProcessed(trackedAnswer.id, {
          reason: "no_correction_detected",
          rationale: correctionResult.rationale,
        }, logger);
      }
    } catch (err) {
      logger.error(`[Correction] Error processing answer ${trackedAnswer.id}: ${err?.message ?? err}`);
    }
  }
}

async function handleFaqCorrection({ app, ctx, trackedAnswer, correctionResult, channelName, areaName, correctionOwnerIds, logger }) {
  const { config } = ctx;
  const isGeneralFaq = trackedAnswer.productAreaId === GENERAL_FAQ_AREA_ID;
  let notionPageId;
  let leadUserIds;
  let blockInfo = null;

  if (isGeneralFaq) {
    const useResponders = trackedAnswer.respondingOwnerIds?.length > 0;
    leadUserIds = useResponders
      ? [...trackedAnswer.respondingOwnerIds]
      : [...config.generalFaq.adminUserIds];
    logger.info(`[Correction] General FAQ correction — DM recipients: ${useResponders ? "responding owners" : "admin fallback"} (${leadUserIds.map(id => `<@${id}>`).join(", ")})`);

    // Search KB sub-pages for the evidence block
    if (trackedAnswer.kbSourcePageIds?.length && trackedAnswer.evidence?.length) {
      logger.info(`[Correction] Searching ${trackedAnswer.kbSourcePageIds.length} KB sub-page(s) for evidence block`);
      for (const subPageId of trackedAnswer.kbSourcePageIds) {
        try {
          blockInfo = await findBlockByContent(subPageId, trackedAnswer.evidence, logger);
          if (blockInfo) {
            notionPageId = subPageId;
            logger.info(`[Correction] Evidence block found in KB sub-page ${subPageId.slice(0, 8)}... (block: ${blockInfo.blockId.slice(0, 8)})`);
            break;
          }
        } catch (err) {
          logger.warn(`[Correction] Error searching KB sub-page ${subPageId.slice(0, 8)}: ${err?.message ?? err}`);
        }
      }
      if (!blockInfo) {
        logger.warn(`[Correction] Evidence block not found in any KB sub-page`);
      }
    } else {
      logger.info(`[Correction] No KB sub-pages stored on answer ${trackedAnswer.id} — will use legacy page`);
    }
    // Fall back to legacy page
    if (!notionPageId) {
      notionPageId = config.generalFaq.notionPageUrl;
      logger.info(`[Correction] Falling back to legacy General FAQ page: ${notionPageId}`);
    }
  } else {
    const area = getKnowledgeAreaById(trackedAnswer.productAreaId);
    if (!area) return;
    notionPageId = area.notionPageId;
    leadUserIds = getLeadUserIds(trackedAnswer.productAreaId);
  }

  if (!leadUserIds || leadUserIds.length === 0) {
    logger.warn(`[Correction] No DM recipients for answer ${trackedAnswer.id}, skipping`);
    return;
  }

  if (!blockInfo && trackedAnswer.evidence && trackedAnswer.evidence.length > 0) {
    try {
      blockInfo = await findBlockByContent(notionPageId, trackedAnswer.evidence, logger);
    } catch (err) {
      logger.warn(`[Correction] Error finding FAQ block in page ${notionPageId}: ${err?.message ?? err}`);
    }
  }

  logger.info(`[Correction] Sending correction DM for answer ${trackedAnswer.id} — notionPage: ${notionPageId?.slice(0, 8) ?? "none"}, blockFound: ${!!blockInfo}, recipients: ${leadUserIds.length}`);

  const dmLines = [
    `A correction was flagged for the *${areaName}* FAQ based on a discussion in #${channelName || "channel"}.`,
    "",
  ];

  if (blockInfo?.blockUrl) {
    dmLines.push(`FAQ entry: <${blockInfo.blockUrl}|View in Notion>`);
  } else {
    const pageId = extractPageId(notionPageId);
    const pageUrl = `https://notion.so/${pageId?.replace(/-/g, "")}`;
    dmLines.push(`FAQ page: <${pageUrl}|View in Notion>`);
  }

  dmLines.push("");
  dmLines.push("*Suggested update:*");
  dmLines.push(correctionResult.suggested_update);
  dmLines.push("");
  dmLines.push("Should I go ahead and update this FAQ entry? Reply *yes* to approve, or tell me what to change.");

  const dmMessage = dmLines.join("\n");
  const correctionId = trackedAnswer.id;

  for (const leadId of leadUserIds) {
    const success = await sendDmToUser(app.client, leadId, dmMessage, logger);
    if (success) {
      setPendingDm(leadId, {
        intent: "faq_correction_approval",
        partialData: {
          correctionId,
          blockId: blockInfo?.blockId || null,
          blockUrl: blockInfo?.blockUrl || null,
          notionPageId,
          subPageId: isGeneralFaq ? notionPageId : null,
          suggestedUpdate: correctionResult.suggested_update,
          originalQuestion: trackedAnswer.originalQuestion,
          areaName,
          channelName,
        },
      });
    }
  }
}

export async function runPeriodicChecks(app, ctx) {
  try {
    await checkPendingEscalations(app, ctx);
    await cleanupOldEscalations();

    if (ctx.config.features.faqCorrection) {
      await checkPendingCorrections(app, ctx);
      await cleanupOldFaqAnswers(30, app.logger);
    }

  } catch (e) {
    app.logger.error(`[Periodic] Failed running periodic checks: ${e?.message ?? e}`);
  }
}
