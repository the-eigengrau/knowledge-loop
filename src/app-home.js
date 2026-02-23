import {
  getAllKnowledgeAreas,
  addKnowledgeArea,
  removeKnowledgeArea,
  updateKnowledgeArea,
  getKnowledgeAreaById,
} from "./knowledge-areas.js";
import { extractPageId, getPageTitle } from "./notion.js";

/**
 * Build the App Home view blocks
 */
async function buildHomeView() {
  const areas = getAllKnowledgeAreas();

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Knowledge Area Configuration",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Configure knowledge areas with their Notion FAQ pages, leads, and team members. Leads get @-tagged on escalations. Team members are recognized as experts (bot won't answer their Qs) and can be auto-discovered from thread replies.",
      },
    },
    {
      type: "divider",
    },
  ];

  if (areas.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_No knowledge areas configured yet. Add one to get started!_",
      },
    });
  } else {
    for (const area of areas) {
      const leadsList = (area.leads ?? []).length
        ? (area.leads ?? []).map((m) => {
            const desc = m.description ? ` _(${m.description})_` : "";
            return `<@${m.userId}>${desc}`;
          }).join(", ")
        : "_No leads set_";

      const teamList = (area.teamMembers ?? []).length
        ? (area.teamMembers ?? []).map((m) => {
            const desc = m.description ? ` _(${m.description})_` : "";
            return `<@${m.userId}>${desc}`;
          }).join(", ")
        : "_None yet_";

      const keywords = area.keywords.length ? area.keywords.join(", ") : "_No keywords_";
      const description = area.description ? `_${area.description}_` : "_No description_";

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${area.name}*\n${description}\n:page_facing_up: Notion: \`${area.notionPageId.slice(0, 20)}...\`\n:star: Leads: ${leadsList}\n:busts_in_silhouette: Team: ${teamList}\n:label: Keywords: ${keywords}`,
        },
        accessory: {
          type: "overflow",
          action_id: `area_overflow_${area.id}`,
          options: [
            {
              text: {
                type: "plain_text",
                text: "Edit",
              },
              value: `edit_${area.id}`,
            },
            {
              text: {
                type: "plain_text",
                text: "Delete",
              },
              value: `delete_${area.id}`,
            },
          ],
        },
      });

      blocks.push({
        type: "divider",
      });
    }
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "Add Knowledge Area",
          emoji: true,
        },
        style: "primary",
        action_id: "add_knowledge_area",
      },
    ],
  });

  return {
    type: "home",
    blocks,
  };
}

/**
 * Build the modal for adding/editing a knowledge area
 */
function buildKnowledgeAreaModal(existingArea = null) {
  const isEdit = !!existingArea;

  return {
    type: "modal",
    callback_id: isEdit ? `edit_area_modal_${existingArea.id}` : "add_area_modal",
    title: {
      type: "plain_text",
      text: isEdit ? "Edit Knowledge Area" : "Add Knowledge Area",
    },
    submit: {
      type: "plain_text",
      text: isEdit ? "Save" : "Add",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "input",
        block_id: "name_block",
        element: {
          type: "plain_text_input",
          action_id: "name_input",
          placeholder: {
            type: "plain_text",
            text: "e.g., Engineering, Sales, Customer Support",
          },
          initial_value: existingArea?.name || "",
        },
        label: {
          type: "plain_text",
          text: "Name",
        },
      },
      {
        type: "input",
        block_id: "description_block",
        element: {
          type: "plain_text_input",
          action_id: "description_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Describe what this knowledge area covers. This helps the AI route questions correctly.",
          },
          initial_value: existingArea?.description || "",
        },
        label: {
          type: "plain_text",
          text: "Description",
        },
        hint: {
          type: "plain_text",
          text: "Describe the topics, features, and use cases this knowledge area covers",
        },
        optional: true,
      },
      {
        type: "input",
        block_id: "notion_block",
        element: {
          type: "plain_text_input",
          action_id: "notion_input",
          placeholder: {
            type: "plain_text",
            text: "https://notion.so/your-page-id or just the page ID",
          },
          initial_value: existingArea?.notionPageId || "",
        },
        label: {
          type: "plain_text",
          text: "Notion Page URL or ID",
        },
      },
      {
        type: "input",
        block_id: "owners_block",
        element: {
          type: "multi_users_select",
          action_id: "owners_input",
          placeholder: {
            type: "plain_text",
            text: "Select leads",
          },
          ...((existingArea?.leads ?? []).length
            ? { initial_users: existingArea.leads.map((m) => m.userId) }
            : existingArea?.ownerUserIds?.length
              ? { initial_users: existingArea.ownerUserIds }
              : {}),
        },
        label: {
          type: "plain_text",
          text: "Leads (tagged on escalations)",
        },
        hint: {
          type: "plain_text",
          text: "These people get @-mentioned when the bot can't answer a question. Team members are auto-discovered from thread replies.",
        },
        optional: true,
      },
      {
        type: "input",
        block_id: "keywords_block",
        element: {
          type: "plain_text_input",
          action_id: "keywords_input",
          placeholder: {
            type: "plain_text",
            text: "keyword1, keyword2, keyword3",
          },
          initial_value: existingArea?.keywords?.join(", ") || "",
        },
        label: {
          type: "plain_text",
          text: "Keywords (comma-separated)",
        },
        hint: {
          type: "plain_text",
          text: "Keywords help classify which questions belong to this knowledge area",
        },
        optional: true,
      },
    ],
  };
}

/**
 * Build confirmation modal for deletion
 */
function buildDeleteConfirmModal(area) {
  return {
    type: "modal",
    callback_id: `delete_area_modal_${area.id}`,
    title: {
      type: "plain_text",
      text: "Delete Knowledge Area",
    },
    submit: {
      type: "plain_text",
      text: "Delete",
      emoji: true,
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Are you sure you want to delete *${area.name}*?\n\nThis will remove the knowledge area configuration. The Notion page will not be affected.`,
        },
      },
    ],
  };
}

/**
 * Register App Home handlers with the Slack app
 */
export function registerAppHomeHandlers(app, logger) {
  // Handle App Home opened event
  app.event("app_home_opened", async ({ event, client }) => {
    try {
      if (event.tab !== "home") return;

      const view = await buildHomeView();
      await client.views.publish({
        user_id: event.user,
        view,
      });
    } catch (error) {
      logger.error(`Error publishing home view: ${error?.message ?? error}`);
    }
  });

  // Handle "Add Knowledge Area" button click
  app.action("add_knowledge_area", async ({ ack, body, client }) => {
    await ack();
    try {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildKnowledgeAreaModal(),
      });
    } catch (error) {
      logger.error(`Error opening add modal: ${error?.message ?? error}`);
    }
  });

  // Handle overflow menu actions (edit/delete)
  app.action(/^area_overflow_/, async ({ ack, body, action, client }) => {
    await ack();
    try {
      const selectedValue = action.selected_option.value;
      const [actionType, areaId] = selectedValue.split("_");

      const area = getKnowledgeAreaById(areaId);
      if (!area) {
        logger.warn(`Knowledge area not found: ${areaId}`);
        return;
      }

      if (actionType === "edit") {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: buildKnowledgeAreaModal(area),
        });
      } else if (actionType === "delete") {
        await client.views.open({
          trigger_id: body.trigger_id,
          view: buildDeleteConfirmModal(area),
        });
      }
    } catch (error) {
      logger.error(`Error handling overflow action: ${error?.message ?? error}`);
    }
  });

  // Handle add area modal submission
  app.view("add_area_modal", async ({ ack, body, view, client }) => {
    logger.info(`[AppHome] Add knowledge area modal submitted by user ${body.user.id}`);
    const values = view.state.values;
    const name = values.name_block.name_input.value?.trim();
    const description = values.description_block.description_input.value?.trim() || "";
    const notionUrl = values.notion_block.notion_input.value?.trim();
    const ownerUserIds = values.owners_block.owners_input.selected_users || [];
    const keywordsRaw = values.keywords_block.keywords_input.value || "";

    // Validate notion page ID
    const notionPageId = extractPageId(notionUrl);
    if (!notionPageId) {
      logger.warn(`[AppHome] Invalid Notion page ID provided: ${notionUrl}`);
      await ack({
        response_action: "errors",
        errors: {
          notion_block: "Invalid Notion page URL or ID",
        },
      });
      return;
    }

    const keywords = keywordsRaw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    try {
      await addKnowledgeArea(
        {
          name,
          description,
          notionPageId: notionUrl, // Store the original URL/ID
          ownerUserIds,
          keywords,
        },
        logger
      );

      await ack();

      // Refresh the home view
      const homeView = await buildHomeView();
      await client.views.publish({
        user_id: body.user.id,
        view: homeView,
      });
    } catch (error) {
      await ack({
        response_action: "errors",
        errors: {
          name_block: error.message,
        },
      });
    }
  });

  // Handle edit area modal submission
  app.view(/^edit_area_modal_/, async ({ ack, body, view, client }) => {
    const areaId = view.callback_id.replace("edit_area_modal_", "");
    logger.info(`[AppHome] Edit knowledge area modal submitted by user ${body.user.id} for area ${areaId}`);
    const values = view.state.values;
    const name = values.name_block.name_input.value?.trim();
    const description = values.description_block.description_input.value?.trim() || "";
    const notionUrl = values.notion_block.notion_input.value?.trim();
    const ownerUserIds = values.owners_block.owners_input.selected_users || [];
    const keywordsRaw = values.keywords_block.keywords_input.value || "";

    // Validate notion page ID
    const notionPageId = extractPageId(notionUrl);
    if (!notionPageId) {
      logger.warn(`[AppHome] Invalid Notion page ID provided: ${notionUrl}`);
      await ack({
        response_action: "errors",
        errors: {
          notion_block: "Invalid Notion page URL or ID",
        },
      });
      return;
    }

    const keywords = keywordsRaw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    try {
      await updateKnowledgeArea(
        areaId,
        {
          name,
          description,
          notionPageId: notionUrl,
          ownerUserIds,
          keywords,
        },
        logger
      );

      await ack();

      // Refresh the home view
      const homeView = await buildHomeView();
      await client.views.publish({
        user_id: body.user.id,
        view: homeView,
      });
    } catch (error) {
      await ack({
        response_action: "errors",
        errors: {
          name_block: error.message,
        },
      });
    }
  });

  // Handle delete confirmation modal submission
  app.view(/^delete_area_modal_/, async ({ ack, body, view, client }) => {
    const areaId = view.callback_id.replace("delete_area_modal_", "");
    logger.info(`[AppHome] Delete knowledge area confirmed by user ${body.user.id} for area ${areaId}`);

    try {
      await removeKnowledgeArea(areaId, logger);
      await ack();

      // Refresh the home view
      const homeView = await buildHomeView();
      await client.views.publish({
        user_id: body.user.id,
        view: homeView,
      });
    } catch (error) {
      logger.error(`Error deleting knowledge area: ${error?.message ?? error}`);
      await ack();
    }
  });
}
