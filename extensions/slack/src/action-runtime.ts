import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { isSingleUseReplyToMode } from "openclaw/plugin-sdk/reply-reference";
import { parseSlackBlocksInput } from "./blocks-input.js";
import {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
  type OpenClawConfig,
  withNormalizedTimestamp,
} from "./runtime-api.js";
import { recordSlackThreadParticipation } from "./sent-thread-cache.js";
import { parseSlackTarget, resolveSlackChannelId } from "./targets.js";

const messagingActions = new Set([
  "sendMessage",
  "uploadFile",
  "editMessage",
  "deleteMessage",
  "readMessages",
  "downloadFile",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);
const canvasActions = new Set([
  "readCanvas",
  "createCanvas",
  "editCanvas",
  "lookupCanvasSections",
  "setCanvasAccess",
  "deleteCanvasAccess",
]);

type SlackActionsRuntimeModule = typeof import("./actions.runtime.js");
type SlackAccountsRuntimeModule = typeof import("./accounts.runtime.js");

let slackActionsRuntimePromise: Promise<SlackActionsRuntimeModule> | undefined;
let slackAccountsRuntimePromise: Promise<SlackAccountsRuntimeModule> | undefined;

function loadSlackActionsRuntime(): Promise<SlackActionsRuntimeModule> {
  slackActionsRuntimePromise ??= import("./actions.runtime.js");
  return slackActionsRuntimePromise;
}

function loadSlackAccountsRuntime(): Promise<SlackAccountsRuntimeModule> {
  slackAccountsRuntimePromise ??= import("./accounts.runtime.js");
  return slackAccountsRuntimePromise;
}

function createLazySlackAction<K extends keyof SlackActionsRuntimeModule>(
  key: K,
): SlackActionsRuntimeModule[K] {
  return (async (...args: unknown[]) => {
    const runtime = await loadSlackActionsRuntime();
    const action = runtime[key] as (...actionArgs: unknown[]) => unknown;
    return action(...args);
  }) as SlackActionsRuntimeModule[K];
}

export const slackActionRuntime = {
  createSlackCanvas: createLazySlackAction("createSlackCanvas"),
  deleteSlackCanvasAccess: createLazySlackAction("deleteSlackCanvasAccess"),
  deleteSlackMessage: createLazySlackAction("deleteSlackMessage"),
  downloadSlackFile: createLazySlackAction("downloadSlackFile"),
  editSlackCanvas: createLazySlackAction("editSlackCanvas"),
  editSlackMessage: createLazySlackAction("editSlackMessage"),
  getSlackMemberInfo: createLazySlackAction("getSlackMemberInfo"),
  listSlackEmojis: createLazySlackAction("listSlackEmojis"),
  listSlackPins: createLazySlackAction("listSlackPins"),
  listSlackReactions: createLazySlackAction("listSlackReactions"),
  lookupSlackCanvasSections: createLazySlackAction("lookupSlackCanvasSections"),
  readSlackCanvas: createLazySlackAction("readSlackCanvas"),
  parseSlackBlocksInput,
  pinSlackMessage: createLazySlackAction("pinSlackMessage"),
  reactSlackMessage: createLazySlackAction("reactSlackMessage"),
  readSlackMessages: createLazySlackAction("readSlackMessages"),
  recordSlackThreadParticipation,
  removeOwnSlackReactions: createLazySlackAction("removeOwnSlackReactions"),
  removeSlackReaction: createLazySlackAction("removeSlackReaction"),
  sendSlackMessage: createLazySlackAction("sendSlackMessage"),
  setSlackCanvasAccess: createLazySlackAction("setSlackCanvasAccess"),
  unpinSlackMessage: createLazySlackAction("unpinSlackMessage"),
};

export type SlackActionContext = {
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all" | "batched";
  /** Mutable ref to track if a reply was sent for single-use reply modes. */
  hasRepliedRef?: { value: boolean };
  /** Allowed local media directories for file uploads. */
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

/**
 * Resolve threadTs for a Slack message based on context and replyToMode.
 * - "all": always inject threadTs
 * - "first"/"batched": inject only for the first eligible message (updates hasRepliedRef)
 * - "off": never auto-inject
 */
function resolveThreadTsFromContext(
  explicitThreadTs: string | undefined,
  targetChannel: string,
  context: SlackActionContext | undefined,
): string | undefined {
  // Agent explicitly provided threadTs - use it
  if (explicitThreadTs) {
    return explicitThreadTs;
  }
  // No context or missing required fields
  if (!context?.currentThreadTs || !context?.currentChannelId) {
    return undefined;
  }

  const parsedTarget = parseSlackTarget(targetChannel, {
    defaultKind: "channel",
  });
  if (!parsedTarget || parsedTarget.kind !== "channel") {
    return undefined;
  }
  const normalizedTarget = parsedTarget.id;

  // Different channel - don't inject
  if (normalizedTarget !== context.currentChannelId) {
    return undefined;
  }

  // Check replyToMode
  if (context.replyToMode === "all") {
    return context.currentThreadTs;
  }
  if (
    isSingleUseReplyToMode(context.replyToMode ?? "off") &&
    context.hasRepliedRef &&
    !context.hasRepliedRef.value
  ) {
    context.hasRepliedRef.value = true;
    return context.currentThreadTs;
  }
  return undefined;
}

function readSlackBlocksParam(params: Record<string, unknown>) {
  return slackActionRuntime.parseSlackBlocksInput(params.blocks);
}

function isImageContentType(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith("image/") === true;
}

function parseJsonParam(value: string, key: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${key} must be valid JSON: ${message}`, { cause: error });
  }
}

function readRecordParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): Record<string, unknown> | undefined {
  const raw = params[key];
  const value = typeof raw === "string" ? parseJsonParam(raw, key) : raw;
  if (value == null) {
    if (options.required) {
      throw new Error(`${key} is required.`);
    }
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readRecordArrayParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean } = {},
): Record<string, unknown>[] | undefined {
  const raw = params[key];
  const value = typeof raw === "string" ? parseJsonParam(raw, key) : raw;
  if (value == null) {
    if (options.required) {
      throw new Error(`${key} is required.`);
    }
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${key} entries must be objects.`);
    }
  }
  return value as Record<string, unknown>[];
}

function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const raw = params[key];
  if (raw == null) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : undefined;
  if (!values) {
    throw new Error(`${key} must be a string array.`);
  }
  return values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
}

function resolveCanvasIdParam(params: Record<string, unknown>): string {
  const raw =
    readStringParam(params, "canvasId") ?? readStringParam(params, "canvasUrl", { required: true });
  const trimmed = raw.trim();
  const match =
    trimmed.match(/\/docs\/[^/]+\/([A-Z0-9]+)/i) ?? trimmed.match(/\/files\/[^/]+\/([A-Z0-9]+)/i);
  return match?.[1] ?? trimmed;
}

function readCanvasDocumentContent(params: Record<string, unknown>) {
  const documentContent = readRecordParam(params, "documentContent");
  if (documentContent) {
    return documentContent;
  }
  const markdown = readStringParam(params, "markdown", { allowEmpty: true });
  return markdown == null ? undefined : { type: "markdown", markdown };
}

function readCanvasChanges(params: Record<string, unknown>): Record<string, unknown>[] {
  const changes = readRecordArrayParam(params, "changes");
  if (changes) {
    return changes;
  }
  const operation = readStringParam(params, "operation", { required: true });
  const sectionId = readStringParam(params, "sectionId");
  const change: Record<string, unknown> = {
    operation,
    ...(sectionId ? { section_id: sectionId } : {}),
  };
  if (operation === "rename") {
    const titleContent = readRecordParam(params, "titleContent");
    const title = readStringParam(params, "title");
    if (!titleContent && !title) {
      throw new Error("Canvas rename requires titleContent or title.");
    }
    change.title_content = titleContent ?? { type: "markdown", markdown: title };
    return [change];
  }
  if (operation !== "delete") {
    const documentContent = readCanvasDocumentContent(params);
    if (!documentContent) {
      throw new Error("Canvas edit requires changes or markdown/documentContent.");
    }
    change.document_content = documentContent;
  }
  return [change];
}

function readCanvasAccessTargets(params: Record<string, unknown>) {
  const channelId = readStringParam(params, "channelId");
  const channelIdsRaw =
    readStringArrayParam(params, "channelIds") ?? (channelId ? [channelId] : undefined);
  const channelIds = channelIdsRaw?.map((id) => resolveSlackChannelId(id));
  const userId = readStringParam(params, "userId");
  const userIds = readStringArrayParam(params, "userIds") ?? (userId ? [userId] : undefined);
  if (channelIds?.length && userIds?.length) {
    throw new Error("Canvas access actions accept channelIds or userIds, not both.");
  }
  if (!channelIds?.length && !userIds?.length) {
    throw new Error("Canvas access actions require channelIds or userIds.");
  }
  return { channelIds, userIds };
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: OpenClawConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const resolveChannelId = () =>
    resolveSlackChannelId(
      readStringParam(params, "channelId", {
        required: true,
      }),
    );
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const { resolveSlackAccount } = await loadSlackAccountsRuntime();
  const account = resolveSlackAccount({ cfg, accountId });
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);
  const userToken = account.userToken;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;

  // Choose the most appropriate token for Slack read/write operations.
  const getTokenForOperation = (operation: "read" | "write") => {
    if (operation === "read") {
      return userToken ?? botToken;
    }
    if (!allowUserWrites) {
      return botToken;
    }
    return botToken ?? userToken;
  };

  const buildActionOpts = (operation: "read" | "write") => {
    const token = getTokenForOperation(operation);
    const tokenOverride = token && token !== botToken ? token : undefined;
    return {
      cfg,
      ...(accountId ? { accountId } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
    };
  };

  const readOpts = buildActionOpts("read");
  const writeOpts = buildActionOpts("write");

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = resolveChannelId();
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      if (remove) {
        if (writeOpts) {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji, writeOpts);
        } else {
          await slackActionRuntime.removeSlackReaction(channelId, messageId, emoji);
        }
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = writeOpts
          ? await slackActionRuntime.removeOwnSlackReactions(channelId, messageId, writeOpts)
          : await slackActionRuntime.removeOwnSlackReactions(channelId, messageId);
        return jsonResult({ ok: true, removed });
      }
      if (writeOpts) {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji, writeOpts);
      } else {
        await slackActionRuntime.reactSlackMessage(channelId, messageId, emoji);
      }
      return jsonResult({ ok: true, added: emoji });
    }
    const reactions = readOpts
      ? await slackActionRuntime.listSlackReactions(channelId, messageId, readOpts)
      : await slackActionRuntime.listSlackReactions(channelId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const blocks = readSlackBlocksParam(params);
        if (!content && !mediaUrl && !blocks) {
          throw new Error("Slack sendMessage requires content, blocks, or mediaUrl.");
        }
        if (mediaUrl && blocks) {
          throw new Error("Slack sendMessage does not support blocks with mediaUrl.");
        }
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
        );
        const result = await slackActionRuntime.sendSlackMessage(to, content ?? "", {
          ...writeOpts,
          mediaUrl: mediaUrl ?? undefined,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          blocks,
        });

        if (threadTs && result.channelId && account.accountId) {
          slackActionRuntime.recordSlackThreadParticipation(
            account.accountId,
            result.channelId,
            threadTs,
          );
        }

        // Keep "first" mode consistent even when the agent explicitly provided
        // threadTs: once we send a message to the current channel, consider the
        // first reply "used" so later tool calls don't auto-thread again.
        if (context?.hasRepliedRef && context.currentChannelId) {
          const parsedTarget = parseSlackTarget(to, { defaultKind: "channel" });
          if (parsedTarget?.kind === "channel" && parsedTarget.id === context.currentChannelId) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "uploadFile": {
        const to = readStringParam(params, "to", { required: true });
        const filePath = readStringParam(params, "filePath", {
          required: true,
          trim: false,
        });
        const initialComment = readStringParam(params, "initialComment", {
          allowEmpty: true,
        });
        const filename = readStringParam(params, "filename");
        const title = readStringParam(params, "title");
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
        );
        const result = await slackActionRuntime.sendSlackMessage(to, initialComment ?? "", {
          ...writeOpts,
          mediaUrl: filePath,
          mediaLocalRoots: context?.mediaLocalRoots,
          mediaReadFile: context?.mediaReadFile,
          threadTs: threadTs ?? undefined,
          ...(filename ? { uploadFileName: filename } : {}),
          ...(title ? { uploadTitle: title } : {}),
        });

        if (threadTs && result.channelId && account.accountId) {
          slackActionRuntime.recordSlackThreadParticipation(
            account.accountId,
            result.channelId,
            threadTs,
          );
        }

        if (context?.hasRepliedRef && context.currentChannelId) {
          const parsedTarget = parseSlackTarget(to, { defaultKind: "channel" });
          if (parsedTarget?.kind === "channel" && parsedTarget.id === context.currentChannelId) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          allowEmpty: true,
        });
        const blocks = readSlackBlocksParam(params);
        if (!content && !blocks) {
          throw new Error("Slack editMessage requires content or blocks.");
        }
        if (writeOpts) {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            ...writeOpts,
            blocks,
          });
        } else {
          await slackActionRuntime.editSlackMessage(channelId, messageId, content ?? "", {
            blocks,
          });
        }
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        if (writeOpts) {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId, writeOpts);
        } else {
          await slackActionRuntime.deleteSlackMessage(channelId, messageId);
        }
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = resolveChannelId();
        const limitRaw = params.limit;
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const result = await slackActionRuntime.readSlackMessages(channelId, {
          ...readOpts,
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
          threadId: threadId ?? undefined,
        });
        const messages = result.messages.map((message) =>
          withNormalizedTimestamp(
            message as Record<string, unknown>,
            (message as { ts?: unknown }).ts,
          ),
        );
        return jsonResult({ ok: true, messages, hasMore: result.hasMore });
      }
      case "downloadFile": {
        const fileId = readStringParam(params, "fileId", { required: true });
        const channelTarget = readStringParam(params, "channelId") ?? readStringParam(params, "to");
        const channelId = channelTarget ? resolveSlackChannelId(channelTarget) : undefined;
        const threadId = readStringParam(params, "threadId") ?? readStringParam(params, "replyTo");
        const maxBytes = account.config?.mediaMaxMb
          ? account.config.mediaMaxMb * 1024 * 1024
          : 20 * 1024 * 1024;
        const readToken = getTokenForOperation("read");
        const downloaded = await slackActionRuntime.downloadSlackFile(fileId, {
          ...readOpts,
          ...(readToken && !readOpts?.token ? { token: readToken } : {}),
          maxBytes,
          channelId,
          threadId: threadId ?? undefined,
        });
        if (!downloaded) {
          return jsonResult({
            ok: false,
            error: "File could not be downloaded (not found, too large, or inaccessible).",
          });
        }
        if (!isImageContentType(downloaded.contentType)) {
          return jsonResult({
            ok: true,
            fileId,
            path: downloaded.path,
            contentType: downloaded.contentType,
            placeholder: downloaded.placeholder,
            media: {
              mediaUrl: downloaded.path,
              ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
            },
          });
        }
        return await imageResultFromFile({
          label: "slack-file",
          path: downloaded.path,
          extraText: downloaded.placeholder,
          details: {
            fileId,
            path: downloaded.path,
            ...(downloaded.contentType ? { contentType: downloaded.contentType } : {}),
          },
        });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = resolveChannelId();
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await slackActionRuntime.pinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.pinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await slackActionRuntime.unpinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    const pins = writeOpts
      ? await slackActionRuntime.listSlackPins(channelId, readOpts)
      : await slackActionRuntime.listSlackPins(channelId);
    const normalizedPins = pins.map((pin) => {
      const message = pin.message
        ? withNormalizedTimestamp(
            pin.message as Record<string, unknown>,
            (pin.message as { ts?: unknown }).ts,
          )
        : pin.message;
      return message ? Object.assign({}, pin, { message }) : pin;
    });
    return jsonResult({ ok: true, pins: normalizedPins });
  }

  if (canvasActions.has(action)) {
    if (!isActionEnabled("canvases")) {
      throw new Error("Slack canvases are disabled.");
    }
    switch (action) {
      case "readCanvas": {
        const canvasId = resolveCanvasIdParam(params);
        const includeHtml = params.includeHtml === true;
        const rawMaxBytes = params.maxBytes;
        const maxBytes =
          typeof rawMaxBytes === "number" && Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
            ? rawMaxBytes
            : undefined;
        const result = await slackActionRuntime.readSlackCanvas(canvasId, {
          ...readOpts,
          includeHtml,
          maxBytes,
        });
        return jsonResult({ ok: true, result });
      }
      case "createCanvas": {
        const title = readStringParam(params, "title");
        const documentContent = readCanvasDocumentContent(params);
        const channelIdRaw = readStringParam(params, "channelId");
        const channelId = channelIdRaw ? resolveSlackChannelId(channelIdRaw) : undefined;
        const result = await slackActionRuntime.createSlackCanvas({
          ...writeOpts,
          title: title ?? undefined,
          documentContent,
          channelId,
        });
        return jsonResult({ ok: true, result });
      }
      case "editCanvas": {
        const canvasId = resolveCanvasIdParam(params);
        const changes = readCanvasChanges(params);
        const result = await slackActionRuntime.editSlackCanvas(canvasId, changes, writeOpts);
        return jsonResult({ ok: true, result });
      }
      case "lookupCanvasSections": {
        const canvasId = resolveCanvasIdParam(params);
        const criteria = readRecordParam(params, "criteria", { required: true })!;
        const result = await slackActionRuntime.lookupSlackCanvasSections(
          canvasId,
          criteria,
          readOpts,
        );
        return jsonResult({ ok: true, result });
      }
      case "setCanvasAccess": {
        const canvasId = resolveCanvasIdParam(params);
        const accessLevel = readStringParam(params, "accessLevel", { required: true });
        if (accessLevel !== "read" && accessLevel !== "write" && accessLevel !== "owner") {
          throw new Error("Canvas accessLevel must be read, write, or owner.");
        }
        const targets = readCanvasAccessTargets(params);
        if (accessLevel === "owner" && targets.channelIds?.length) {
          throw new Error("Canvas owner access can only be granted to userIds.");
        }
        const result = await slackActionRuntime.setSlackCanvasAccess(canvasId, accessLevel, {
          ...writeOpts,
          ...targets,
        });
        return jsonResult({ ok: true, result });
      }
      case "deleteCanvasAccess": {
        const canvasId = resolveCanvasIdParam(params);
        const targets = readCanvasAccessTargets(params);
        const result = await slackActionRuntime.deleteSlackCanvasAccess(canvasId, {
          ...writeOpts,
          ...targets,
        });
        return jsonResult({ ok: true, result });
      }
      default:
        break;
    }
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const info = writeOpts
      ? await slackActionRuntime.getSlackMemberInfo(userId, readOpts)
      : await slackActionRuntime.getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const result = readOpts
      ? await slackActionRuntime.listSlackEmojis(readOpts)
      : await slackActionRuntime.listSlackEmojis();
    const limit = readNumberParam(params, "limit", { integer: true });
    if (limit != null && limit > 0 && result.emoji != null) {
      const entries = Object.entries(result.emoji).toSorted(([a], [b]) => a.localeCompare(b));
      if (entries.length > limit) {
        return jsonResult({
          ok: true,
          emojis: {
            ...result,
            emoji: Object.fromEntries(entries.slice(0, limit)),
          },
        });
      }
    }
    return jsonResult({ ok: true, emojis: result });
  }

  throw new Error(`Unknown action: ${action}`);
}
