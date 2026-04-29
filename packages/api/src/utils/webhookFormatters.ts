import type { WebhookPlatform } from "@kan/db/schema";

import type { WebhookPayload } from "./webhook";

/**
 * Build the human-readable summary line shown in chat messages.
 */
function summary(payload: WebhookPayload): string {
  const { card, list, fromList, board, user } = payload.data;
  const who = user?.name ?? "Someone";
  const cardTitle = card?.title ?? "card";
  const listName = list?.name;
  const fromListName = fromList?.name;
  const boardName = board?.name;

  const onBoard = boardName ? ` on ${boardName}` : "";
  const inList = listName ? ` in *${listName}*` : "";

  switch (payload.event) {
    case "card.created":
      return `${who} created card *${cardTitle}*${inList}${onBoard}`;
    case "card.moved":
      if (fromListName && listName) {
        return `${who} moved *${cardTitle}* from *${fromListName}* to *${listName}*${onBoard}`;
      }
      return listName
        ? `${who} moved *${cardTitle}* to *${listName}*${onBoard}`
        : `${who} moved *${cardTitle}*${onBoard}`;
    case "card.updated":
      return `${who} updated *${cardTitle}*${inList}${onBoard}`;
    case "card.deleted":
      return `${who} deleted *${cardTitle}*${inList}${onBoard}`;
    case "list.created":
      return `${who} added list *${listName ?? "list"}*${onBoard}`;
  }
}

/**
 * Convert a generic Kan webhook payload into the JSON shape expected
 * by the target chat platform. Returning the unchanged payload for
 * `generic` keeps backwards compatibility with custom integrations.
 */
export function formatForPlatform(
  platform: WebhookPlatform,
  payload: WebhookPayload,
): unknown {
  switch (platform) {
    case "generic":
      return payload;
    case "google_chat":
      return { text: summary(payload) };
    case "slack":
      return { text: summary(payload), mrkdwn: true };
    case "discord":
      return { content: summary(payload) };
    case "teams":
      return { "@type": "MessageCard", text: summary(payload) };
  }
}
