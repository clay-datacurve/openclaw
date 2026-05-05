import { Type } from "typebox";

const SlackCanvasLooseObjectSchema = Type.Object({}, { additionalProperties: true });

export function createSlackCanvasToolSchemaProperties() {
  return {
    canvasId: Type.Optional(
      Type.String({
        description: "Slack Canvas ID, e.g. F1234ABCD. Canvas URLs are also accepted.",
      }),
    ),
    canvasUrl: Type.Optional(Type.String({ description: "Slack Canvas URL." })),
    title: Type.Optional(Type.String({ description: "Canvas title or upload title." })),
    markdown: Type.Optional(
      Type.String({ description: "Markdown content for Slack Canvas create/edit operations." }),
    ),
    documentContent: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          markdown: Type.Optional(Type.String()),
        },
        {
          additionalProperties: true,
          description:
            "Slack Canvas document_content object. For markdown use {type:'markdown', markdown:'...'}.",
        },
      ),
    ),
    changes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            operation: Type.Optional(Type.String()),
            section_id: Type.Optional(Type.String()),
            sectionId: Type.Optional(Type.String()),
            document_content: Type.Optional(SlackCanvasLooseObjectSchema),
            title_content: Type.Optional(SlackCanvasLooseObjectSchema),
          },
          {
            additionalProperties: true,
            description:
              "Slack canvases.edit changes array. Slack currently supports one change per call.",
          },
        ),
      ),
    ),
    operation: Type.Optional(
      Type.String({
        description:
          "Canvas edit shorthand operation: insert_after, insert_before, insert_at_start, insert_at_end, replace, delete, or rename.",
      }),
    ),
    sectionId: Type.Optional(Type.String({ description: "Slack Canvas section id." })),
    titleContent: Type.Optional(
      Type.Object(
        { type: Type.Optional(Type.String()), markdown: Type.Optional(Type.String()) },
        {
          additionalProperties: true,
          description: "Slack Canvas title_content object for rename.",
        },
      ),
    ),
    criteria: Type.Optional(
      Type.Object(
        {
          section_types: Type.Optional(Type.Array(Type.String())),
          contains_text: Type.Optional(Type.String()),
        },
        {
          additionalProperties: true,
          description: "Criteria for canvases.sections.lookup.",
        },
      ),
    ),
    accessLevel: Type.Optional(
      Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("owner")], {
        description: "Canvas access level for canvases.access.set.",
      }),
    ),
    channelId: Type.Optional(
      Type.String({ description: "Slack channel ID for Canvas create/access changes." }),
    ),
    channelIds: Type.Optional(
      Type.Array(Type.String({ description: "Slack channel IDs for Canvas access changes." })),
    ),
    userId: Type.Optional(Type.String({ description: "Slack user ID for Canvas access changes." })),
    userIds: Type.Optional(
      Type.Array(Type.String({ description: "Slack user IDs for Canvas access changes." })),
    ),
  };
}

export function createSlackMessageToolBlocksSchema() {
  return Type.Array(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Slack Block Kit payload blocks (Slack only).",
      },
    ),
  );
}
