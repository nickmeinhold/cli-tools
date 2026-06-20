#!/usr/bin/env node
// gcal — CLI for Google Calendar (replaces Anthropic-hosted MCP).

import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { getAuthClient, runConsentFlow } from "./auth.mjs";
import { runDispatcher, out } from "./cli-base.mjs";

async function calClient() {
  const auth = await getAuthClient();
  return google.calendar({ version: "v3", auth });
}

function parseJson(json) {
  return JSON.parse(json === "-" ? readFileSync(0, "utf8") : json);
}

const COMMANDS = {
  auth: {
    help: "Run interactive OAuth consent (shared with gmail; one-time per 7 days)",
    opts: {},
    async run() {
      await runConsentFlow();
      out({ status: "authenticated" });
    },
  },

  "list-calendars": {
    help: "List all calendars accessible to the user",
    opts: {},
    async run() {
      const cal = await calClient();
      const res = await cal.calendarList.list();
      out(res.data.items || []);
    },
  },

  "list-events": {
    help: "List events on a calendar within a time range",
    opts: {
      "calendar-id": { type: "string" },
      "time-min": { type: "string" },
      "time-max": { type: "string" },
      query: { type: "string" },
      "max-results": { type: "string" },
      "single-events": { type: "string" },
      "order-by": { type: "string" },
    },
    async run({ calendarId, timeMin, timeMax, query, maxResults, singleEvents, orderBy }) {
      const cal = await calClient();
      const res = await cal.events.list({
        calendarId: calendarId || "primary",
        timeMin: timeMin || new Date().toISOString(),
        timeMax,
        q: query,
        maxResults: maxResults ? Number(maxResults) : 50,
        singleEvents: singleEvents !== "false",
        orderBy: orderBy || "startTime",
      });
      out(res.data.items || []);
    },
  },

  "get-event": {
    help: "Get a single event by ID",
    opts: {
      "calendar-id": { type: "string" },
      "event-id": { type: "string" },
    },
    required: ["event-id"],
    async run({ calendarId, eventId }) {
      const cal = await calClient();
      const res = await cal.events.get({
        calendarId: calendarId || "primary",
        eventId,
      });
      out(res.data);
    },
  },

  "create-event": {
    help: "Create an event. Pass full body via --json or use --summary/--start/--end/--attendee flags",
    opts: {
      "calendar-id": { type: "string" },
      json: { type: "string" },
      summary: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      attendee: { type: "string", multiple: true },
      "send-updates": { type: "string" },
    },
    async run({ calendarId, json, summary, description, location, start, end, attendee, sendUpdates }) {
      const cal = await calClient();
      let requestBody;
      if (json) {
        requestBody = parseJson(json);
      } else {
        if (!summary || !start || !end) {
          throw new Error("Either --json or all of --summary --start --end are required");
        }
        const startObj = start.length <= 10 ? { date: start } : { dateTime: start };
        const endObj = end.length <= 10 ? { date: end } : { dateTime: end };
        requestBody = {
          summary,
          description,
          location,
          start: startObj,
          end: endObj,
          attendees: (attendee || []).map((email) => ({ email })),
        };
      }
      const res = await cal.events.insert({
        calendarId: calendarId || "primary",
        requestBody,
        sendUpdates: sendUpdates || "none",
      });
      out(res.data);
    },
  },

  "update-event": {
    help: "Patch-update an event. --event-id ID, fields via flags or --json",
    opts: {
      "calendar-id": { type: "string" },
      "event-id": { type: "string" },
      json: { type: "string" },
      summary: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      "send-updates": { type: "string" },
    },
    required: ["event-id"],
    async run({ calendarId, eventId, json, summary, description, location, start, end, sendUpdates }) {
      const cal = await calClient();
      let requestBody;
      if (json) {
        requestBody = parseJson(json);
      } else {
        requestBody = {};
        if (summary !== undefined) requestBody.summary = summary;
        if (description !== undefined) requestBody.description = description;
        if (location !== undefined) requestBody.location = location;
        if (start) requestBody.start = start.length <= 10 ? { date: start } : { dateTime: start };
        if (end) requestBody.end = end.length <= 10 ? { date: end } : { dateTime: end };
      }
      const res = await cal.events.patch({
        calendarId: calendarId || "primary",
        eventId,
        requestBody,
        sendUpdates: sendUpdates || "none",
      });
      out(res.data);
    },
  },

  "delete-event": {
    help: "Delete an event",
    opts: {
      "calendar-id": { type: "string" },
      "event-id": { type: "string" },
      "send-updates": { type: "string" },
    },
    required: ["event-id"],
    async run({ calendarId, eventId, sendUpdates }) {
      const cal = await calClient();
      await cal.events.delete({
        calendarId: calendarId || "primary",
        eventId,
        sendUpdates: sendUpdates || "none",
      });
      out({ deleted: eventId });
    },
  },

  "respond-to-event": {
    help: "Respond to an invitation: --response accepted|declined|tentative",
    opts: {
      "calendar-id": { type: "string" },
      "event-id": { type: "string" },
      response: { type: "string" },
      "self-email": { type: "string" },
    },
    required: ["event-id", "response"],
    async run({ calendarId, eventId, response, selfEmail }) {
      const cal = await calClient();
      const ev = await cal.events.get({
        calendarId: calendarId || "primary",
        eventId,
      });
      const attendees = ev.data.attendees || [];
      const me = selfEmail
        ? attendees.find((a) => a.email === selfEmail)
        : attendees.find((a) => a.self);
      if (!me) {
        throw new Error("No matching attendee on event (use --self-email to override)");
      }
      me.responseStatus = response;
      const res = await cal.events.patch({
        calendarId: calendarId || "primary",
        eventId,
        requestBody: { attendees },
      });
      out(res.data);
    },
  },

  "suggest-time": {
    help: "Find free slots across calendars (FreeBusy query)",
    opts: {
      "time-min": { type: "string" },
      "time-max": { type: "string" },
      "calendar-id": { type: "string", multiple: true },
    },
    required: ["time-min", "time-max"],
    async run({ timeMin, timeMax, calendarId }) {
      const cal = await calClient();
      const items = (calendarId && calendarId.length ? calendarId : ["primary"]).map((id) => ({ id }));
      const res = await cal.freebusy.query({
        requestBody: { timeMin, timeMax, items },
      });
      out(res.data);
    },
  },
};

await runDispatcher("gcal", COMMANDS);
