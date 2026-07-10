#!/usr/bin/env node
// gdrive — CLI for Google Drive (full scope: auth/drive).
// Wraps the most-used Drive v3 verbs. Output is JSON to stdout for everything
// except `download` (binary file content goes to stdout or --output path).

import { google } from "googleapis";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getAuthClient, runConsentFlow } from "./auth.mjs";
import { runDispatcher, out } from "./cli-base.mjs";

async function driveClient() {
  const auth = await getAuthClient();
  return google.drive({ version: "v3", auth });
}

const FILE_FIELDS =
  "id,name,mimeType,parents,size,modifiedTime,createdTime,webViewLink,owners,trashed,starred";

const COMMANDS = {
  auth: {
    help: "Run interactive OAuth consent (shared with gmail/gcal)",
    opts: {},
    async run() {
      await runConsentFlow();
      out({ status: "authenticated" });
    },
  },

  about: {
    help: "Get account info: storage quota, user, max upload size",
    opts: {},
    async run() {
      const drive = await driveClient();
      const res = await drive.about.get({
        fields: "user,storageQuota,maxUploadSize,maxImportSizes",
      });
      out(res.data);
    },
  },

  list: {
    help: "List files. --query uses Drive search syntax (e.g. \"name contains 'report'\")",
    opts: {
      query: { type: "string" },
      "page-size": { type: "string" },
      "page-token": { type: "string" },
      "order-by": { type: "string" }, // e.g. "modifiedTime desc"
      "include-trashed": { type: "string" }, // "true" to include
      "drive-id": { type: "string" }, // for Shared Drives
      corpora: { type: "string" }, // user|drive|allDrives|domain
      fields: { type: "string" }, // override default
    },
    async run({ query, pageSize, pageToken, orderBy, includeTrashed, driveId, corpora, fields }) {
      const drive = await driveClient();
      let q = query || "";
      if (includeTrashed !== "true") {
        q = q ? `(${q}) and trashed=false` : "trashed=false";
      }
      const res = await drive.files.list({
        q,
        pageSize: pageSize ? Number(pageSize) : 100,
        pageToken,
        orderBy: orderBy || "modifiedTime desc",
        driveId,
        corpora: corpora || (driveId ? "drive" : undefined),
        includeItemsFromAllDrives: !!driveId || corpora === "allDrives",
        supportsAllDrives: true,
        fields: fields || `nextPageToken, files(${FILE_FIELDS})`,
      });
      out({
        files: res.data.files || [],
        nextPageToken: res.data.nextPageToken || null,
      });
    },
  },

  get: {
    help: "Get file metadata by ID",
    opts: {
      "file-id": { type: "string" },
      fields: { type: "string" },
    },
    required: ["file-id"],
    async run({ fileId, fields }) {
      const drive = await driveClient();
      const res = await drive.files.get({
        fileId,
        fields: fields || FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  download: {
    help: "Download file content. --output PATH (default stdout). For Google Docs use `export`.",
    opts: {
      "file-id": { type: "string" },
      output: { type: "string" },
    },
    required: ["file-id"],
    async run({ fileId, output }) {
      const drive = await driveClient();
      const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      );
      const dest = output ? createWriteStream(output) : process.stdout;
      await pipeline(res.data, dest);
      if (output) process.stderr.write(`Wrote ${output}\n`);
    },
  },

  export: {
    help: "Export a Google Doc/Sheet/Slides as another format. --mime-type e.g. application/pdf",
    opts: {
      "file-id": { type: "string" },
      "mime-type": { type: "string" },
      output: { type: "string" },
    },
    required: ["file-id", "mime-type"],
    async run({ fileId, mimeType, output }) {
      const drive = await driveClient();
      const res = await drive.files.export(
        { fileId, mimeType },
        { responseType: "stream" }
      );
      const dest = output ? createWriteStream(output) : process.stdout;
      await pipeline(res.data, dest);
      if (output) process.stderr.write(`Wrote ${output}\n`);
    },
  },

  upload: {
    help: "Upload a local file. --path FILE [--name N] [--parent FOLDER_ID] [--mime-type T] [--source-mime-type T]. Use --mime-type application/vnd.google-apps.document + --source-mime-type text/html to convert HTML to a Google Doc on upload.",
    opts: {
      path: { type: "string" },
      name: { type: "string" },
      parent: { type: "string", multiple: true },
      "mime-type": { type: "string" },
      "source-mime-type": { type: "string" },
      description: { type: "string" },
    },
    required: ["path"],
    async run({ path, name, parent, mimeType, sourceMimeType, description }) {
      const drive = await driveClient();
      statSync(path); // throws if missing
      const res = await drive.files.create({
        requestBody: {
          name: name || basename(path),
          parents: parent && parent.length ? parent : undefined,
          description,
          mimeType: mimeType || undefined,
        },
        media: {
          mimeType: sourceMimeType || mimeType || undefined,
          body: createReadStream(path),
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  "update-content": {
    help: "Replace an existing file's content from a local path",
    opts: {
      "file-id": { type: "string" },
      path: { type: "string" },
      "mime-type": { type: "string" },
    },
    required: ["file-id", "path"],
    async run({ fileId, path, mimeType }) {
      const drive = await driveClient();
      statSync(path);
      const res = await drive.files.update({
        fileId,
        media: {
          mimeType: mimeType || undefined,
          body: createReadStream(path),
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  "update-metadata": {
    help: "Update name/description/starred. --file-id ID [--name N] [--description D] [--starred true|false]",
    opts: {
      "file-id": { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      starred: { type: "string" },
      "mime-type": { type: "string" },
    },
    required: ["file-id"],
    async run({ fileId, name, description, starred, mimeType }) {
      const drive = await driveClient();
      const requestBody = {};
      if (name !== undefined) requestBody.name = name;
      if (description !== undefined) requestBody.description = description;
      if (starred !== undefined) requestBody.starred = starred === "true";
      if (mimeType !== undefined) requestBody.mimeType = mimeType;
      const res = await drive.files.update({
        fileId,
        requestBody,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  move: {
    help: "Move a file: change its parent folder. --file-id ID --add-parent ID [--remove-parent ID]",
    opts: {
      "file-id": { type: "string" },
      "add-parent": { type: "string" },
      "remove-parent": { type: "string" },
    },
    required: ["file-id", "add-parent"],
    async run({ fileId, addParent, removeParent }) {
      const drive = await driveClient();
      // If --remove-parent not given, pull all current parents and remove them.
      let removeParents = removeParent;
      if (!removeParents) {
        const cur = await drive.files.get({
          fileId,
          fields: "parents",
          supportsAllDrives: true,
        });
        removeParents = (cur.data.parents || []).join(",");
      }
      const res = await drive.files.update({
        fileId,
        addParents: addParent,
        removeParents,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  copy: {
    help: "Copy a file. --file-id ID [--name N] [--parent FOLDER_ID]",
    opts: {
      "file-id": { type: "string" },
      name: { type: "string" },
      parent: { type: "string", multiple: true },
    },
    required: ["file-id"],
    async run({ fileId, name, parent }) {
      const drive = await driveClient();
      const res = await drive.files.copy({
        fileId,
        requestBody: {
          name,
          parents: parent && parent.length ? parent : undefined,
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  delete: {
    help: "Delete a file permanently (skips trash). Use `trash` for soft-delete.",
    opts: { "file-id": { type: "string" } },
    required: ["file-id"],
    async run({ fileId }) {
      const drive = await driveClient();
      await drive.files.delete({ fileId, supportsAllDrives: true });
      out({ deleted: fileId });
    },
  },

  trash: {
    help: "Move a file to trash (soft delete, recoverable)",
    opts: { "file-id": { type: "string" } },
    required: ["file-id"],
    async run({ fileId }) {
      const drive = await driveClient();
      const res = await drive.files.update({
        fileId,
        requestBody: { trashed: true },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  untrash: {
    help: "Restore a file from trash",
    opts: { "file-id": { type: "string" } },
    required: ["file-id"],
    async run({ fileId }) {
      const drive = await driveClient();
      const res = await drive.files.update({
        fileId,
        requestBody: { trashed: false },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  "empty-trash": {
    help: "Permanently delete every file in trash",
    opts: {},
    async run() {
      const drive = await driveClient();
      await drive.files.emptyTrash();
      out({ status: "trash emptied" });
    },
  },

  mkdir: {
    help: "Create a folder. --name N [--parent ID]",
    opts: {
      name: { type: "string" },
      parent: { type: "string", multiple: true },
    },
    required: ["name"],
    async run({ name, parent }) {
      const drive = await driveClient();
      const res = await drive.files.create({
        requestBody: {
          name,
          parents: parent && parent.length ? parent : undefined,
          mimeType: "application/vnd.google-apps.folder",
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  // ── Permissions / sharing ───────────────────────────────────────

  "list-permissions": {
    help: "List who has access to a file",
    opts: { "file-id": { type: "string" } },
    required: ["file-id"],
    async run({ fileId }) {
      const drive = await driveClient();
      const res = await drive.permissions.list({
        fileId,
        fields: "permissions(id,type,role,emailAddress,domain,displayName,deleted)",
        supportsAllDrives: true,
      });
      out(res.data.permissions || []);
    },
  },

  share: {
    help: "Grant access. --file-id ID --role reader|commenter|writer|fileOrganizer|organizer --type user|group|domain|anyone [--email E] [--domain D] [--message M] [--notify true|false]",
    opts: {
      "file-id": { type: "string" },
      role: { type: "string" },
      type: { type: "string" },
      email: { type: "string" },
      domain: { type: "string" },
      message: { type: "string" },
      notify: { type: "string" },
    },
    required: ["file-id", "role", "type"],
    async run({ fileId, role, type, email, domain, message, notify }) {
      const drive = await driveClient();
      const requestBody = { role, type };
      if (email) requestBody.emailAddress = email;
      if (domain) requestBody.domain = domain;
      const res = await drive.permissions.create({
        fileId,
        requestBody,
        sendNotificationEmail: notify === "true",
        emailMessage: message,
        fields: "id,type,role,emailAddress,domain",
        supportsAllDrives: true,
      });
      out(res.data);
    },
  },

  unshare: {
    help: "Revoke a permission by ID (use list-permissions to find it)",
    opts: {
      "file-id": { type: "string" },
      "permission-id": { type: "string" },
    },
    required: ["file-id", "permission-id"],
    async run({ fileId, permissionId }) {
      const drive = await driveClient();
      await drive.permissions.delete({
        fileId,
        permissionId,
        supportsAllDrives: true,
      });
      out({ revoked: permissionId });
    },
  },

  // ── Comments ────────────────────────────────────────────────────

  "list-comments": {
    help: "List comments on a file",
    opts: {
      "file-id": { type: "string" },
      "include-deleted": { type: "string" },
    },
    required: ["file-id"],
    async run({ fileId, includeDeleted }) {
      const drive = await driveClient();
      const res = await drive.comments.list({
        fileId,
        includeDeleted: includeDeleted === "true",
        fields: "comments(id,content,author,createdTime,modifiedTime,resolved,deleted,replies)",
      });
      out(res.data.comments || []);
    },
  },

  "add-comment": {
    help: "Add a comment to a file",
    opts: {
      "file-id": { type: "string" },
      content: { type: "string" },
    },
    required: ["file-id", "content"],
    async run({ fileId, content }) {
      const drive = await driveClient();
      const res = await drive.comments.create({
        fileId,
        requestBody: { content },
        fields: "id,content,author,createdTime",
      });
      out(res.data);
    },
  },

  // ── Shared Drives ───────────────────────────────────────────────

  "list-shared-drives": {
    help: "List Shared Drives the user can access",
    opts: { "page-size": { type: "string" } },
    async run({ pageSize }) {
      const drive = await driveClient();
      const res = await drive.drives.list({
        pageSize: pageSize ? Number(pageSize) : 100,
      });
      out(res.data.drives || []);
    },
  },

  // ── Generate IDs (useful for batch uploads where parent must be known up-front) ──

  "generate-ids": {
    help: "Pre-generate file IDs (handy when you need to know the ID before upload)",
    opts: { count: { type: "string" } },
    async run({ count }) {
      const drive = await driveClient();
      const res = await drive.files.generateIds({
        count: count ? Number(count) : 10,
      });
      out(res.data.ids || []);
    },
  },
};

await runDispatcher("gdrive", COMMANDS);
