import { describe, it, expect } from "vitest";

import { formatForPlatform } from "./webhookFormatters";
import type { WebhookPayload } from "./webhook";

const basePayload: WebhookPayload = {
  event: "card.created",
  timestamp: "2024-01-15T12:00:00.000Z",
  data: {
    card: {
      id: "card-123",
      title: "Login bug",
      description: null,
      dueDate: null,
      listId: "list-456",
      boardId: "board-789",
    },
    board: { id: "board-789", name: "Backend" },
    user: { id: "user-1", name: "Achilleas" },
  },
};

describe("formatForPlatform", () => {
  it("returns the payload unchanged for the generic platform", () => {
    expect(formatForPlatform("generic", basePayload)).toBe(basePayload);
  });

  it("formats a Google Chat message with list and board", () => {
    const payload: WebhookPayload = {
      ...basePayload,
      data: { ...basePayload.data, list: { id: "list-1", name: "To Do" } },
    };
    const out = formatForPlatform("google_chat", payload) as { text: string };
    expect(out.text).toBe(
      "Achilleas created card *Login bug* in *To Do* on Backend",
    );
  });

  it("formats a card.moved with from→to lists", () => {
    const payload: WebhookPayload = {
      ...basePayload,
      event: "card.moved",
      data: {
        ...basePayload.data,
        list: { id: "list-2", name: "Done" },
        fromList: { id: "list-1", name: "In Progress" },
      },
    };
    const out = formatForPlatform("slack", payload) as { text: string };
    expect(out.text).toBe(
      "Achilleas moved *Login bug* from *In Progress* to *Done* on Backend",
    );
  });

  it("formats a list.created event", () => {
    const payload: WebhookPayload = {
      event: "list.created",
      timestamp: "2024-01-15T12:00:00.000Z",
      data: {
        list: { id: "list-1", name: "Backlog" },
        board: { id: "board-789", name: "Backend" },
        user: { id: "user-1", name: "Achilleas" },
      },
    };
    const out = formatForPlatform("google_chat", payload) as { text: string };
    expect(out.text).toBe("Achilleas added list *Backlog* on Backend");
  });

  it("formats a Slack message with mrkdwn", () => {
    const out = formatForPlatform("slack", basePayload) as {
      text: string;
      mrkdwn: boolean;
    };
    expect(out.mrkdwn).toBe(true);
    expect(out.text).toContain("Login bug");
  });

  it("formats a Discord message with content", () => {
    const out = formatForPlatform("discord", basePayload) as { content: string };
    expect(out.content).toContain("Login bug");
  });

  it("formats a Teams MessageCard", () => {
    const out = formatForPlatform("teams", basePayload) as {
      "@type": string;
      text: string;
    };
    expect(out["@type"]).toBe("MessageCard");
    expect(out.text).toContain("Login bug");
  });

  it("falls back to 'Someone' when user is missing", () => {
    const payload: WebhookPayload = {
      ...basePayload,
      data: { ...basePayload.data, user: undefined },
    };
    const out = formatForPlatform("google_chat", payload) as { text: string };
    expect(out.text.startsWith("Someone")).toBe(true);
  });

  it("varies the verb by event", () => {
    const moved: WebhookPayload = { ...basePayload, event: "card.moved" };
    const out = formatForPlatform("slack", moved) as { text: string };
    expect(out.text).toContain("moved");
  });
});
