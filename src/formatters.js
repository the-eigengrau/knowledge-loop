import { truncate } from "./slack-helpers.js";

export function formatAnswer(result, areaName, showEvidence = false) {
  const lines = [];

  if (result.answer && result.answer.trim()) {
    lines.push(result.answer.trim());
  }

  if (showEvidence && result.evidence?.length) {
    lines.push("");
    lines.push("*Evidence (from FAQ):*");
    for (const e of result.evidence.slice(0, 3)) {
      lines.push(`> ${e}`);
    }
  }

  if (result.follow_up_questions?.length) {
    lines.push("");
    lines.push("*If you want to sanity-check, I'd ask:*");
    for (const q of result.follow_up_questions.slice(0, 2)) {
      lines.push(`• ${q}`);
    }
  }

  return lines.join("\n");
}

export function formatPartialAnswer(result, areaName, ownerUserIds, notionFaqUrl, showEvidence = false) {
  const lines = [];

  if (result.answer && result.answer.trim()) {
    lines.push(result.answer.trim());
  }

  if (showEvidence && result.evidence?.length) {
    lines.push("");
    lines.push("*Evidence (from FAQ):*");
    for (const e of result.evidence.slice(0, 3)) {
      lines.push(`> ${e}`);
    }
  }

  const pings = ownerUserIds.length
    ? ownerUserIds.map((id) => `<@${id}>`).join(" ")
    : "(no owners configured for this area)";
  const faqPhrase = notionFaqUrl
    ? `<${notionFaqUrl}|*${areaName} FAQ*>`
    : `*${areaName} FAQ*`;
  lines.push("");
  lines.push(`${pings} — The ${faqPhrase} only partially covers this. Mind filling in the gaps?`);

  if (result.follow_up_questions?.length) {
    lines.push("");
    for (const q of result.follow_up_questions.slice(0, 2)) {
      lines.push(`• ${q}`);
    }
  }

  lines.push("");
  lines.push("_Once you respond, I'll update the FAQ shortly after._");

  return lines.join("\n");
}

export function formatEscalation({ questionText, followUps, ownerUserIds, areaName, notionFaqUrl }) {
  const pings = ownerUserIds.length
    ? ownerUserIds.map((id) => `<@${id}>`).join(" ")
    : "(no owners configured for this area)";

  const faqPhrase = notionFaqUrl
    ? `<${notionFaqUrl}|*${areaName} FAQ*>`
    : `*${areaName} FAQ*`;
  const lines = [];
  lines.push(`${pings} I couldn't find this in the ${faqPhrase} yet. Mind weighing in?`);
  lines.push("");
  lines.push(`> ${truncate(questionText, 1200)}`);

  if (followUps?.length) {
    lines.push("");
    lines.push("To help them respond, can you clarify:");
    for (const q of followUps.slice(0, 2)) {
      lines.push(`• ${q}`);
    }
  }

  lines.push("");
  lines.push("_Once you respond, I'll update the FAQ shortly after._");

  return lines.join("\n");
}

export function formatTimeAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatRosterArea(area) {
  const lines = [`*Team Roster: ${area.name}*`];
  const leads = area.leads ?? [];
  const members = area.teamMembers ?? [];

  lines.push(`:star: *Leads* (${leads.length}):`);
  if (leads.length === 0) {
    lines.push("  _(none)_");
  } else {
    for (const m of leads) {
      const desc = m.description ? `_${m.description}_` : "_(no description)_";
      lines.push(`  <@${m.userId}> — ${desc} (active: ${formatTimeAgo(m.lastActiveAt)})`);
    }
  }

  lines.push(`:busts_in_silhouette: *Team Members* (${members.length}):`);
  if (members.length === 0) {
    lines.push("  _(none)_");
  } else {
    for (const m of members) {
      const desc = m.description ? `_${m.description}_` : "_(no description)_";
      const addedBy = m.addedBy ? `, added: ${m.addedBy}` : "";
      lines.push(`  <@${m.userId}> — ${desc} (active: ${formatTimeAgo(m.lastActiveAt)}${addedBy})`);
    }
  }

  return lines.join("\n");
}
