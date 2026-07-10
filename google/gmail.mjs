#!/usr/bin/env node
// gmail — CLI for Google Gmail (replaces Anthropic-hosted MCP).
// Verbs match the prior MCP set, minus rarely-used label-by-thread variants.

import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { getAuthClient, runConsentFlow } from "./auth.mjs";
import { runDispatcher, out } from "./cli-base.mjs";

async function gmailClient() {
  const auth = await getAuthClient();
  return google.gmail({ version: "v1", auth });
}

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

const mimeFor = (file) => MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream";
const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
// Wrap base64 at 76 chars per line (RFC 2045 requirement for body/attachment parts).
const wrap76 = (b64) => b64.match(/.{1,76}/g)?.join("\r\n") ?? "";

// RFC 2047 "encoded-word" for header values containing non-ASCII (e.g. Thai subjects).
// Header bytes can't carry raw UTF-8 the way a base64 body part can, so a non-ASCII Subject
// sent verbatim gets misread downstream and arrives as mojibake. Pure-ASCII passes through
// untouched; otherwise we Base64-encode as one or more =?UTF-8?B?...?= words, folded so each
// encoded-word stays under the 75-char limit and chunked on code-point boundaries so a
// multi-byte character is never split across words.
function encodeHeaderValue(value) {
  if (/^[\x00-\x7F]*$/.test(value)) return value; // pure ASCII — leave as-is
  const words = [];
  let chunk = "";
  const flush = () => {
    if (chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf-8").toString("base64")}?=`);
      chunk = "";
    }
  };
  for (const ch of Array.from(value)) { // Array.from splits by code point (keeps surrogate pairs whole)
    if (Buffer.byteLength(chunk + ch, "utf-8") > 45) flush(); // 45 UTF-8 bytes -> ~60 b64 chars + ~12 overhead < 75
    chunk += ch;
  }
  flush();
  return words.join("\r\n "); // CRLF + space folds multiple encoded-words per RFC 2047
}

function encodeRfc822({ to, subject, body, cc, bcc, attach, from }) {
  const files = (Array.isArray(attach) ? attach : attach ? [attach] : []).filter(Boolean);
  const baseHeaders = [];
  // `From` must be a verified Gmail "Send mail as" alias on the authed account,
  // otherwise the Gmail API silently rewrites it back to the authed primary.
  if (from) baseHeaders.push(`From: ${from}`);
  baseHeaders.push(`To: ${to}`, `Subject: ${encodeHeaderValue(subject)}`);
  if (cc) baseHeaders.push(`Cc: ${cc}`);
  if (bcc) baseHeaders.push(`Bcc: ${bcc}`);

  // No attachments: plain-text message (original behaviour).
  if (files.length === 0) {
    const headers = [...baseHeaders, "Content-Type: text/plain; charset=utf-8"];
    return b64url(Buffer.from(headers.join("\r\n") + "\r\n\r\n" + body, "utf-8"));
  }

  // Attachments present: multipart/mixed. Body sent as base64 so UTF-8 (Thai etc.) survives.
  const boundary = "b_" + Math.random().toString(36).slice(2) + "_" + Date.now().toString(36);
  const headers = [
    ...baseHeaders,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  let msg = headers.join("\r\n") + "\r\n\r\n";
  msg +=
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    wrap76(Buffer.from(body, "utf-8").toString("base64")) +
    "\r\n";
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`Attachment not found: ${file}`);
    const name = basename(file);
    msg +=
      `--${boundary}\r\n` +
      `Content-Type: ${mimeFor(file)}; name="${name}"\r\n` +
      "Content-Transfer-Encoding: base64\r\n" +
      `Content-Disposition: attachment; filename="${name}"\r\n\r\n` +
      wrap76(readFileSync(file).toString("base64")) +
      "\r\n";
  }
  msg += `--${boundary}--`;
  return b64url(Buffer.from(msg, "utf-8"));
}

const COMMANDS = {
  auth: {
    help: "Run interactive OAuth consent (one-time setup, opens browser)",
    opts: {},
    async run() {
      await runConsentFlow();
      out({ status: "authenticated" });
    },
  },

  "list-labels": {
    help: "List all labels in the mailbox",
    opts: {},
    async run() {
      const gmail = await gmailClient();
      const res = await gmail.users.labels.list({ userId: "me" });
      out(res.data.labels || []);
    },
  },

  "create-label": {
    help: "Create a new label",
    opts: {
      name: { type: "string" },
      "label-list-visibility": { type: "string" }, // labelShow|labelHide|labelShowIfUnread
      "message-list-visibility": { type: "string" }, // show|hide
    },
    required: ["name"],
    async run({ name, labelListVisibility, messageListVisibility }) {
      const gmail = await gmailClient();
      const res = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name,
          labelListVisibility: labelListVisibility || "labelShow",
          messageListVisibility: messageListVisibility || "show",
        },
      });
      out(res.data);
    },
  },

  "search-threads": {
    help: "Search threads by Gmail query string (e.g. 'from:foo subject:bar')",
    opts: {
      query: { type: "string" },
      "max-results": { type: "string" },
      "page-token": { type: "string" },
    },
    required: ["query"],
    async run({ query, maxResults, pageToken }) {
      const gmail = await gmailClient();
      const res = await gmail.users.threads.list({
        userId: "me",
        q: query,
        maxResults: maxResults ? Number(maxResults) : 25,
        pageToken,
      });
      out({
        threads: res.data.threads || [],
        nextPageToken: res.data.nextPageToken || null,
        resultSizeEstimate: res.data.resultSizeEstimate || 0,
      });
    },
  },

  "get-thread": {
    help: "Get a thread by ID, including all messages",
    opts: {
      "thread-id": { type: "string" },
      format: { type: "string" }, // minimal|full|metadata|raw
    },
    required: ["thread-id"],
    async run({ threadId, format }) {
      const gmail = await gmailClient();
      const res = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: format || "full",
      });
      out(res.data);
    },
  },

  "get-attachment": {
    help: "Download an attachment. --message-id ID [--attachment-id ID | --filename NAME] [--out PATH] [--list]",
    opts: {
      "message-id": { type: "string" },
      "attachment-id": { type: "string" },
      filename: { type: "string" },
      out: { type: "string" },
      list: { type: "boolean" },
    },
    required: ["message-id"],
    async run({ messageId, attachmentId, filename, out: outPath, list }) {
      const gmail = await gmailClient();
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      // Walk the MIME tree collecting every part that is a real attachment
      // (has a filename and an attachmentId — inline text parts have neither).
      const attachments = [];
      const walk = (part) => {
        if (part.filename && part.body?.attachmentId) {
          attachments.push({
            filename: part.filename,
            mimeType: part.mimeType,
            size: part.body.size,
            attachmentId: part.body.attachmentId,
          });
        }
        for (const child of part.parts || []) walk(child);
      };
      walk(msg.data.payload);

      if (list) {
        out({ messageId, attachments });
        return;
      }
      if (attachments.length === 0) {
        throw new Error(`Message ${messageId} has no attachments`);
      }

      // Resolve which attachment to download.
      let target;
      if (attachmentId) {
        target = attachments.find((a) => a.attachmentId === attachmentId) || { attachmentId };
      } else if (filename) {
        target = attachments.find((a) => a.filename === filename);
        if (!target) {
          throw new Error(
            `No attachment named "${filename}". Available: ${attachments.map((a) => a.filename).join(", ")}`
          );
        }
      } else if (attachments.length === 1) {
        target = attachments[0];
      } else {
        throw new Error(
          `Message has ${attachments.length} attachments; pass --attachment-id or --filename. ` +
            `Available: ${attachments.map((a) => a.filename).join(", ")}`
        );
      }

      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: target.attachmentId,
      });
      const buf = Buffer.from(res.data.data, "base64");

      // Default output: the attachment's own name (basename, so a crafted
      // filename can't escape the cwd) in the current directory.
      const dest = outPath || join(process.cwd(), basename(target.filename || "attachment"));
      writeFileSync(dest, buf);
      out({
        status: "downloaded",
        file: dest,
        bytes: buf.length,
        mimeType: target.mimeType || null,
        filename: target.filename || null,
      });
    },
  },

  "list-drafts": {
    help: "List drafts",
    opts: {
      "max-results": { type: "string" },
      "page-token": { type: "string" },
      query: { type: "string" },
    },
    async run({ maxResults, pageToken, query }) {
      const gmail = await gmailClient();
      const res = await gmail.users.drafts.list({
        userId: "me",
        maxResults: maxResults ? Number(maxResults) : 25,
        pageToken,
        q: query,
      });
      out({
        drafts: res.data.drafts || [],
        nextPageToken: res.data.nextPageToken || null,
      });
    },
  },

  "create-draft": {
    help: "Create a draft. --to addr --subject S --body TEXT [--cc --bcc --from --thread-id ID] [--attach FILE ...]",
    opts: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      cc: { type: "string" },
      bcc: { type: "string" },
      from: { type: "string" },
      "thread-id": { type: "string" },
      attach: { type: "string", multiple: true },
    },
    required: ["to", "subject", "body"],
    async run({ to, subject, body, cc, bcc, from, threadId, attach }) {
      const gmail = await gmailClient();
      const raw = encodeRfc822({ to, subject, body, cc, bcc, attach, from });
      const res = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw, threadId } },
      });
      out(res.data);
    },
  },

  send: {
    help: "Send a new message immediately. --to --subject --body [--cc --bcc --thread-id --from] [--attach FILE ...]",
    opts: {
      to: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      cc: { type: "string" },
      bcc: { type: "string" },
      from: { type: "string" },
      "thread-id": { type: "string" },
      attach: { type: "string", multiple: true },
    },
    required: ["to", "subject", "body"],
    async run({ to, subject, body, cc, bcc, from, threadId, attach }) {
      const gmail = await gmailClient();
      const raw = encodeRfc822({ to, subject, body, cc, bcc, attach, from });
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId },
      });
      out(res.data);
    },
  },

  "send-draft": {
    help: "Send an existing draft by ID",
    opts: { "draft-id": { type: "string" } },
    required: ["draft-id"],
    async run({ draftId }) {
      const gmail = await gmailClient();
      const res = await gmail.users.drafts.send({
        userId: "me",
        requestBody: { id: draftId },
      });
      out(res.data);
    },
  },

  "delete-draft": {
    help: "Permanently delete a draft by ID (does not send it)",
    opts: { "draft-id": { type: "string" } },
    required: ["draft-id"],
    async run({ draftId }) {
      const gmail = await gmailClient();
      await gmail.users.drafts.delete({ userId: "me", id: draftId });
      out({ status: "deleted", draftId });
    },
  },

  "label-message": {
    help: "Add/remove labels on a message",
    opts: {
      "message-id": { type: "string" },
      "add-label-id": { type: "string", multiple: true },
      "remove-label-id": { type: "string", multiple: true },
    },
    required: ["message-id"],
    async run({ messageId, addLabelId, removeLabelId }) {
      const gmail = await gmailClient();
      const res = await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          addLabelIds: addLabelId || [],
          removeLabelIds: removeLabelId || [],
        },
      });
      out(res.data);
    },
  },

  "label-thread": {
    help: "Add/remove labels on a thread",
    opts: {
      "thread-id": { type: "string" },
      "add-label-id": { type: "string", multiple: true },
      "remove-label-id": { type: "string", multiple: true },
    },
    required: ["thread-id"],
    async run({ threadId, addLabelId, removeLabelId }) {
      const gmail = await gmailClient();
      const res = await gmail.users.threads.modify({
        userId: "me",
        id: threadId,
        requestBody: {
          addLabelIds: addLabelId || [],
          removeLabelIds: removeLabelId || [],
        },
      });
      out(res.data);
    },
  },
};

await runDispatcher("gmail", COMMANDS);
