import type { WebhookPlatform } from "@kan/db/schema";

import type { WebhookPayload } from "./webhook";

/**
 * Build the human-readable summary line shown in chat messages.
 */
function summary(payload: WebhookPayload): string {
  const { card, board, user } = payload.data;
  const who = user?.name ?? "Someone";
  const cardTitle = card.title;
  const boardName = board?.name;

  switch (payload.event) {
    case "card.created":
      return boardName
        ? `${who} created *${cardTitle}* on ${boardName}`
        : `${who} created *${cardTitle}*`;
    case "card.moved":
      return `${who} moved *${cardTitle}*`;
    case "card.updated":
      return `${who} updated *${cardTitle}*`;
    case "card.deleted":
      return `${who} deleted *${cardTitle}*`;
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
