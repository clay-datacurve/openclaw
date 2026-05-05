---
name: slack
description: Use the Slack tool to react, pin/unpin, send, edit, delete messages, manage Canvas settings, or fetch Slack member info.
metadata: { "openclaw": { "emoji": "💬", "requires": { "config": ["channels.slack"] } } }
---

# Slack Actions

## Overview

Use the Slack-backed `message` actions to react, manage pins, send/edit/delete messages, fetch member info, and manage Slack Canvases. The tool uses the Slack token configured for OpenClaw.

## Inputs to collect

- `channelId` and `messageId` (Slack message timestamp, e.g. `1712023032.1234`).
- For reactions, an `emoji` (Unicode or `:name:`).
- For message sends, a `to` target (`channel:<id>` or `user:<id>`) and `content`.

Message context lines include `slack message id` and `channel` fields you can reuse directly.

## Actions

### Action groups

| Action group | Default | Notes                                  |
| ------------ | ------- | -------------------------------------- |
| reactions    | enabled | React + list reactions                 |
| messages     | enabled | Read/send/edit/delete                  |
| pins         | enabled | Pin/unpin/list                         |
| memberInfo   | enabled | Member info                            |
| emojiList    | enabled | Custom emoji list                      |
| canvases     | enabled | Canvas create/edit/lookup/access APIs. |

Disable Canvas actions with `channels.slack.actions.canvases: false` or per-account `channels.slack.accounts.<id>.actions.canvases: false`.

### React to a message

```json
{
  "action": "react",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "emoji": "✅"
}
```

### List reactions

```json
{
  "action": "reactions",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### Send a message

```json
{
  "action": "sendMessage",
  "to": "channel:C123",
  "content": "Hello from OpenClaw"
}
```

### Edit a message

```json
{
  "action": "editMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234",
  "content": "Updated text"
}
```

### Delete a message

```json
{
  "action": "deleteMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### Read recent messages

```json
{
  "action": "readMessages",
  "channelId": "C123",
  "limit": 20
}
```

### Pin a message

```json
{
  "action": "pinMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### Unpin a message

```json
{
  "action": "unpinMessage",
  "channelId": "C123",
  "messageId": "1712023032.1234"
}
```

### List pinned items

```json
{
  "action": "listPins",
  "channelId": "C123"
}
```

### Member info

```json
{
  "action": "memberInfo",
  "userId": "U123"
}
```

### Emoji list

```json
{
  "action": "emojiList"
}
```

### Slack Canvases

Slack's Web API supports Canvas create/edit, section lookup, and access settings. It does **not** currently expose a full Canvas body read/export method, so section lookup can find section IDs for targeted edits but cannot return the full document text.

Required Slack scopes: `canvases:read` for section lookup, `canvases:write` for create/edit/access updates. The setup manifest includes both scopes for new installs. Existing Slack apps need the scopes added and the app reinstalled.

`canvasId` may be a raw Canvas/file ID like `F1234ABCD` or a Slack docs/files URL such as `https://workspace.slack.com/docs/T123/F1234ABCD`.

#### Canvas create

For free Slack workspaces, provide `channelId`.

```json
{
  "action": "canvas-create",
  "title": "Plan",
  "markdown": "# Plan\nInitial notes",
  "channelId": "C123"
}
```

#### Canvas edit

Use `operation` plus `markdown` for the common one-change path, or pass Slack's raw `changes` array.

```json
{
  "action": "canvas-edit",
  "canvasUrl": "https://workspace.slack.com/docs/T123/F1234ABCD",
  "operation": "insert_at_end",
  "markdown": "Update text"
}
```

#### Canvas section lookup

Use this to find `sectionId` values for `insert_before`, `insert_after`, `replace`, or `delete`.

```json
{
  "action": "canvas-section-lookup",
  "canvasId": "F1234ABCD",
  "criteria": {
    "section_types": ["any_header"],
    "contains_text": "Plan"
  }
}
```

#### Canvas access

Use either `channelIds` or `userIds`, not both. `accessLevel` may be `read`, `write`, or `owner`; owner can only be used with users.

```json
{
  "action": "canvas-access-set",
  "canvasId": "F1234ABCD",
  "accessLevel": "write",
  "channelIds": ["C123"]
}
```

```json
{
  "action": "canvas-access-delete",
  "canvasId": "F1234ABCD",
  "userIds": ["U123"]
}
```

## Ideas to try

- React with ✅ to mark completed tasks.
- Pin key decisions or weekly status updates.
- Use `canvas-section-lookup` before targeted Canvas edits that need a section ID.
