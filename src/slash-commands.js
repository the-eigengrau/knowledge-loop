import { normalizeQuotes, fetchAllUsers, resolveUsersByName } from "./slack-helpers.js";
import { formatRosterArea } from "./formatters.js";
import { extractPageId } from "./notion.js";
import {
  getAllKnowledgeAreas,
  getKnowledgeAreaByName,
  getKnowledgeAreaById,
  addKnowledgeArea,
  removeKnowledgeArea,
  updateKnowledgeArea,
  addTeamMember,
  promoteToLead,
  demoteToTeamMember,
} from "./knowledge-areas.js";

export function registerSlashCommand(app, ctx) {
  const { config } = ctx;
  const commandName = config.slashCommand || "/kbot";

  app.command(commandName, async ({ command, ack, respond }) => {
    await ack();

    const normalizedText = normalizeQuotes(command.text.trim());
    const args = normalizedText.split(/\s+/);
    const subcommand = args[0]?.toLowerCase() || "help";

    try {
      switch (subcommand) {
        case "list": {
          const areas = getAllKnowledgeAreas();
          if (areas.length === 0) {
            await respond({
              text: `No knowledge areas configured. Use \`${commandName} add\` or the App Home to add one.`,
            });
            return;
          }

          const lines = ["*Configured Knowledge Areas:*", ""];
          for (const area of areas) {
            const leadsList = (area.leads ?? []).length
              ? (area.leads ?? []).map((m) => {
                  const desc = m.description ? ` — _${m.description}_` : "";
                  return `<@${m.userId}>${desc}`;
                }).join(", ")
              : "_No leads_";
            const teamList = (area.teamMembers ?? []).length
              ? (area.teamMembers ?? []).map((m) => {
                  const desc = m.description ? ` — _${m.description}_` : "";
                  return `<@${m.userId}>${desc}`;
                }).join(", ")
              : "_No team members_";

            lines.push(`• *${area.name}* (ID: \`${area.id}\`)`);
            if (area.description) {
              lines.push(`  _${area.description}_`);
            }
            lines.push(`  Notion: \`${area.notionPageId.slice(0, 30)}...\``);
            lines.push(`  :star: Leads: ${leadsList}`);
            lines.push(`  :busts_in_silhouette: Team: ${teamList}`);
            lines.push(`  Keywords: ${area.keywords.join(", ") || "_none_"}`);
            lines.push("");
          }

          await respond({ text: lines.join("\n") });
          break;
        }

        case "add": {
          app.logger.info(`[Slash] Add command from user ${command.user_id}`);
          const nameMatch = normalizedText.match(/add\s+"([^"]+)"/);
          const urlMatch = normalizedText.match(/https?:\/\/[^\s]+|[a-f0-9]{32}/i);
          const userMatches = normalizedText.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g) || [];
          const ownersMatch = normalizedText.match(/owners?:"([^"]+)"/i);
          const descriptionMatch = normalizedText.match(/description:"([^"]+)"/i);
          const keywordsMatch = normalizedText.match(/keywords?:([^\s]+)/i);

          if (!nameMatch || !urlMatch) {
            await respond({
              text: `Usage: \`${commandName} add "Name" <notion_url> owners:"Name1,Name2" description:"What this area covers" keywords:key1,key2\``,
            });
            return;
          }

          const name = nameMatch[1];
          const notionPageId = urlMatch[0];
          const description = descriptionMatch ? descriptionMatch[1] : "";
          const keywords = keywordsMatch
            ? keywordsMatch[1].split(",").map((k) => k.trim()).filter(Boolean)
            : [];

          let ownerUserIds = userMatches.map((m) => m.match(/<@([A-Z0-9]+)/)?.[1]).filter(Boolean);

          if (ownersMatch && ownerUserIds.length === 0) {
            const ownerNames = ownersMatch[1].split(",").map((n) => n.trim()).filter(Boolean);
            if (ownerNames.length > 0) {
              app.logger.info(`[Slash] Looking up owners by name: ${ownerNames.join(", ")}`);
              const resolvedIds = await resolveUsersByName(app.client, ownerNames, app.logger);
              ownerUserIds = resolvedIds;
            }
          }

          if (!extractPageId(notionPageId)) {
            await respond({ text: "Invalid Notion page URL or ID." });
            return;
          }

          const area = await addKnowledgeArea({ name, description, notionPageId, ownerUserIds, keywords }, app.logger);
          const ownersList = ownerUserIds.length ? ownerUserIds.map((id) => `<@${id}>`).join(", ") : "_No owners_";
          await respond({
            text: `Added knowledge area *${area.name}* (ID: \`${area.id}\`)\nOwners: ${ownersList}${description ? `\n_${description}_` : ""}`,
          });
          break;
        }

        case "remove": {
          app.logger.info(`[Slash] Remove command from user ${command.user_id}`);
          const nameOrId = args.slice(1).join(" ").trim().replace(/^"|"$/g, "");
          if (!nameOrId) {
            await respond({ text: `Usage: \`${commandName} remove <name or id>\`` });
            return;
          }

          const area = getKnowledgeAreaByName(nameOrId) || getKnowledgeAreaById(nameOrId);
          if (!area) {
            await respond({ text: `Knowledge area "${nameOrId}" not found.` });
            return;
          }

          await removeKnowledgeArea(area.id, app.logger);
          await respond({ text: `Removed knowledge area *${area.name}*.` });
          break;
        }

        case "set-owners":
        case "set-leads": {
          app.logger.info(`[Slash] Set-leads command from user ${command.user_id}`);
          const nameMatch = normalizedText.match(/set-(?:owners|leads)\s+"([^"]+)"/);
          const userMatches = normalizedText.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g) || [];
          const ownersMatch = normalizedText.match(/(?:owners?|leads?):"([^"]+)"/i);

          if (!nameMatch) {
            await respond({
              text: `Usage: \`${commandName} set-leads "Name" leads:"Lead1,Lead2"\``,
            });
            return;
          }

          const name = nameMatch[1];
          const area = getKnowledgeAreaByName(name);
          if (!area) {
            await respond({ text: `Knowledge area "${name}" not found.` });
            return;
          }

          let ownerUserIds = userMatches.map((m) => m.match(/<@([A-Z0-9]+)/)?.[1]).filter(Boolean);

          if (ownersMatch && ownerUserIds.length === 0) {
            const ownerNames = ownersMatch[1].split(",").map((n) => n.trim()).filter(Boolean);
            if (ownerNames.length > 0) {
              app.logger.info(`[Slash] Looking up leads by name: ${ownerNames.join(", ")}`);
              ownerUserIds = await resolveUsersByName(app.client, ownerNames, app.logger);
            }
          }

          await updateKnowledgeArea(area.id, { ownerUserIds }, app.logger);

          const ownersList = ownerUserIds.length
            ? ownerUserIds.map((id) => `<@${id}>`).join(", ")
            : "_No leads_";
          await respond({
            text: `Updated leads for *${area.name}*: ${ownersList}`,
          });
          break;
        }

        case "set-team": {
          app.logger.info(`[Slash] Set-team command from user ${command.user_id}`);
          const nameMatch = normalizedText.match(/set-team\s+"([^"]+)"/);
          const userMatches = normalizedText.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g) || [];
          const membersMatch = normalizedText.match(/members?:"([^"]+)"/i);

          if (!nameMatch) {
            await respond({
              text: `Usage: \`${commandName} set-team "Name" members:"Member1,Member2"\``,
            });
            return;
          }

          const name = nameMatch[1];
          const area = getKnowledgeAreaByName(name);
          if (!area) {
            await respond({ text: `Knowledge area "${name}" not found.` });
            return;
          }

          let memberUserIds = userMatches.map((m) => m.match(/<@([A-Z0-9]+)/)?.[1]).filter(Boolean);

          if (membersMatch && memberUserIds.length === 0) {
            const memberNames = membersMatch[1].split(",").map((n) => n.trim()).filter(Boolean);
            if (memberNames.length > 0) {
              app.logger.info(`[Slash] Looking up team members by name: ${memberNames.join(", ")}`);
              memberUserIds = await resolveUsersByName(app.client, memberNames, app.logger);
            }
          }

          let addedCount = 0;
          for (const uid of memberUserIds) {
            try {
              await addTeamMember(area.id, uid, "", "manual", app.logger);
              addedCount++;
            } catch (err) {
              app.logger.warn(`[Slash] Failed to add team member ${uid}: ${err?.message ?? err}`);
            }
          }

          const membersList = memberUserIds.length
            ? memberUserIds.map((id) => `<@${id}>`).join(", ")
            : "_No members_";
          await respond({
            text: `Added ${addedCount} team member(s) to *${area.name}*: ${membersList}`,
          });
          break;
        }

        case "promote": {
          app.logger.info(`[Slash] Promote command from user ${command.user_id}`);
          const nameMatch = normalizedText.match(/promote\s+"([^"]+)"/);
          const userMatch = normalizedText.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);

          if (!nameMatch || !userMatch) {
            await respond({
              text: `Usage: \`${commandName} promote "Name" @user\``,
            });
            return;
          }

          const name = nameMatch[1];
          const userId = userMatch[1];
          const area = getKnowledgeAreaByName(name);
          if (!area) {
            await respond({ text: `Knowledge area "${name}" not found.` });
            return;
          }

          try {
            await promoteToLead(area.id, userId, app.logger);
            await respond({
              text: `Promoted <@${userId}> to lead for *${area.name}*.`,
            });
          } catch (err) {
            await respond({ text: `Error: ${err?.message ?? "Unknown error"}` });
          }
          break;
        }

        case "demote": {
          app.logger.info(`[Slash] Demote command from user ${command.user_id}`);
          const nameMatch = normalizedText.match(/demote\s+"([^"]+)"/);
          const userMatch = normalizedText.match(/<@([A-Z0-9]+)(?:\|[^>]+)?>/);

          if (!nameMatch || !userMatch) {
            await respond({
              text: `Usage: \`${commandName} demote "Name" @user\``,
            });
            return;
          }

          const name = nameMatch[1];
          const userId = userMatch[1];
          const area = getKnowledgeAreaByName(name);
          if (!area) {
            await respond({ text: `Knowledge area "${name}" not found.` });
            return;
          }

          try {
            await demoteToTeamMember(area.id, userId, app.logger);
            await respond({
              text: `Demoted <@${userId}> from lead to team member for *${area.name}*.`,
            });
          } catch (err) {
            await respond({ text: `Error: ${err?.message ?? "Unknown error"}` });
          }
          break;
        }

        case "set-description": {
          app.logger.info(`[Slash] Set-description command from user ${command.user_id}`);
          const matches = normalizedText.match(/set-description\s+"([^"]+)"\s+"([^"]+)"/);

          if (!matches) {
            await respond({
              text: `Usage: \`${commandName} set-description "Name" "Description of what this area covers"\``,
            });
            return;
          }

          const name = matches[1];
          const description = matches[2];
          const area = getKnowledgeAreaByName(name);
          if (!area) {
            await respond({ text: `Knowledge area "${name}" not found.` });
            return;
          }

          await updateKnowledgeArea(area.id, { description }, app.logger);
          await respond({
            text: `Updated description for *${area.name}*:\n_${description}_`,
          });
          break;
        }

        case "lookup": {
          app.logger.info(`[Slash] Lookup command from user ${command.user_id}`);
          const searchTerm = args.slice(1).join(" ").trim().replace(/^"|"$/g, "");

          if (!searchTerm) {
            await respond({ text: `Usage: \`${commandName} lookup <name>\`` });
            return;
          }

          const allUsers = await fetchAllUsers(app.client);
          const wanted = searchTerm.toLowerCase();

          const matches = allUsers
            .filter((u) => !u.deleted && !u.is_bot && u.id)
            .filter((u) => {
              const real = (u.real_name ?? "").toLowerCase();
              const display = (u.profile?.display_name ?? "").toLowerCase();
              const name = (u.name ?? "").toLowerCase();
              return real.includes(wanted) || display.includes(wanted) || name.includes(wanted);
            })
            .slice(0, 10)
            .map((u) => `• <@${u.id}> (ID: \`${u.id}\`) - ${u.real_name || u.name}`);

          if (matches.length === 0) {
            await respond({ text: `No users found matching "${searchTerm}"` });
          } else {
            await respond({ text: `*Users matching "${searchTerm}":*\n${matches.join("\n")}` });
          }
          break;
        }

        case "roster": {
          app.logger.info(`[Slash] Roster command from user ${command.user_id}`);
          const areaName = args.slice(1).join(" ").trim().replace(/^"|"$/g, "");

          if (areaName) {
            const area = getKnowledgeAreaByName(areaName) || getKnowledgeAreaById(areaName);
            if (!area) {
              await respond({ text: `Knowledge area "${areaName}" not found. Use \`${commandName} roster\` to see all areas.` });
              return;
            }
            await respond({ text: formatRosterArea(area) });
          } else {
            const areas = getAllKnowledgeAreas();
            if (areas.length === 0) {
              await respond({ text: "No knowledge areas configured." });
              return;
            }
            const blocks = areas.map(formatRosterArea);
            await respond({ text: blocks.join("\n\n———\n\n") });
          }
          break;
        }

        case "help":
        default: {
          await respond({
            text: `*${config.botName} Commands:*
• \`${commandName} list\` - List all knowledge areas with leads and team members
• \`${commandName} add "Name" <notion_url> owners:"Name1,Name2" description:"..." keywords:key1,key2\` - Add a knowledge area
• \`${commandName} remove <name or id>\` - Remove a knowledge area
• \`${commandName} set-leads "Name" leads:"Lead1,Lead2"\` - Set leads (tagged on escalations)
• \`${commandName} set-team "Name" members:"Member1,Member2"\` - Add team members (recognized experts, not tagged)
• \`${commandName} promote "Name" @user\` - Promote a team member to lead
• \`${commandName} demote "Name" @user\` - Demote a lead to team member
• \`${commandName} set-description "Name" "Description"\` - Update area description
• \`${commandName} roster ["Area Name"]\` - Inspect the learned team roster (leads, members, descriptions, activity)
• \`${commandName} lookup <name>\` - Look up a user by name to get their ID
• \`${commandName} help\` - Show this help message

_Leads get @-tagged on escalations. Team members are recognized as experts (bot won't answer their questions) but aren't tagged._
_Team members can also be auto-discovered when they provide substantive answers in threads._
_The roster is stored separately from config, so team data persists across deployments._

You can also manage knowledge areas from the App Home tab.`,
          });
          break;
        }
      }
    } catch (err) {
      app.logger.error(`Slash command error: ${err?.message ?? err}`);
      await respond({ text: `Error: ${err?.message ?? "Unknown error"}` });
    }
  });
}
