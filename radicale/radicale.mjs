#!/usr/bin/env node
// radicale.mjs — CalDAV CLI for Radicale (zero-dependency, Node 18+).
//
// Wraps Radicale's CalDAV API so calendar ops are first-class instead of
// hand-curled PROPFIND/REPORT/PUT/MKCALENDAR. Mirrors the kan/outline CLI
// pattern (single self-contained .mjs, no npm deps, --site routing, --help).
//
// Recurrence + timezone expansion is done SERVER-SIDE via RFC 4791
// `REPORT calendar-query` with `<C:expand>` — Radicale returns concrete UTC
// instances, so this CLI never reimplements an iCalendar recurrence engine.
//
// AUTH (per site, env-driven):
//   RADICALE_<SITE>_USERNAME / RADICALE_<SITE>_PASSWORD   (site-specific)
//   RADICALE_USERNAME / RADICALE_PASSWORD                 (generic fallback)
//   RADICALE_BASE_URL                                     (overrides --site base)
// A container/host that sets the generic trio works unmodified.
//
// Radicale rights note: Radicale collections are owner-only by default. A path
// the authenticated user lacks rights to returns a silent 403 — pass the FULL
// collection URL you have rights to.

import { parseArgs } from 'node:util';

// Map short --site names to Radicale base URLs. Override any of these with
// RADICALE_BASE_URL, or add your own hosts here.
const SITES = {
  example: 'https://dav.example.com',
};

// ── config / auth ──────────────────────────────────────────────────────────
function resolveAuth(site) {
  const S = site.toUpperCase();
  const base =
    process.env.RADICALE_BASE_URL || SITES[site] || SITES.example;
  const username =
    process.env[`RADICALE_${S}_USERNAME`] || process.env.RADICALE_USERNAME;
  const password =
    process.env[`RADICALE_${S}_PASSWORD`] || process.env.RADICALE_PASSWORD;
  if (!username || !password) {
    fail(
      `Missing credentials. Set RADICALE_${S}_USERNAME/PASSWORD or ` +
        `RADICALE_USERNAME/PASSWORD in the environment.`,
    );
  }
  return { base: base.replace(/\/$/, ''), username, password };
}

function authHeader({ username, password }) {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

// SECURITY: an absolute URL is only honoured if it shares the configured
// Radicale origin — otherwise the CLI would send the user's Basic-auth creds
// to an arbitrary host (credential exfiltration via a crafted --calendar/
// --addressbook, e.g. through a prompt-injected agent in a public room).
function sameOrigin(u, base) {
  try {
    return new URL(u).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
function resolveCollection(base, value, flag) {
  if (!value) return null;
  // Canonicalize through the URL parser so `..`/`.` segments are normalized
  // BEFORE the origin check (a raw string compare could be fooled by traversal
  // that a downstream consumer later collapses) — Carnot, cage-match PR #115.
  let u;
  try {
    u = /^https?:\/\//.test(value)
        ? new URL(value)
        : new URL(value.replace(/^\//, ''), base.replace(/\/?$/, '/'));
  } catch {
    fail(`invalid ${flag} value: ${value}`);
  }
  if (!sameOrigin(u.href, base)) {
    fail(
      `refusing cross-origin ${flag} URL (${value}); it must be on the ` +
        `configured Radicale host (${base}). Pass a "<user>/<name>" path.`,
    );
  }
  // Server-side rights (Radicale is owner-only) remain the authz backstop for
  // which principal/collection the authed user may actually touch.
  return u.href.replace(/\/?$/, '/');
}

// Absolute URL (same-origin only) as-is; otherwise resolve a path against base.
function calUrl(base, calendar) {
  return resolveCollection(base, calendar, '--calendar');
}

// ── CalDAV transport ───────────────────────────────────────────────────────
async function dav(method, url, auth, { body, depth, contentType } = {}) {
  const headers = { Authorization: authHeader(auth) };
  if (depth != null) headers.Depth = String(depth);
  if (contentType) headers['Content-Type'] = contentType;
  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch (e) {
    fail(`network error: ${e.message}`);
  }
  const text = await res.text();
  if (res.status === 403) {
    fail(
      `403 Forbidden for ${url} — the authed user lacks rights to this ` +
        `collection (Radicale is owner-only by default). Check the path.`,
    );
  }
  if (res.status >= 400) {
    fail(`HTTP ${res.status} ${res.statusText} for ${method} ${url}\n${text}`);
  }
  return { status: res.status, text };
}

// ── tiny iCal helpers ──────────────────────────────────────────────────────
// Unfold RFC 5545 line folding (continuation lines start with space/tab).
function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

// Compute the UTC instant for a wall-clock time in an IANA zone (zero-dep).
// Two-pass offset trick: format a UTC guess in the zone, measure the skew.
function wallToUtc(y, mo, d, hh, mm, ss, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asSeenInTz = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour % 24), +p.minute, +p.second);
  return new Date(guess - (asSeenInTz - guess));
}

// "20260627T050000Z" | "20260627T150000" (+ optional tz) | "20260627" → ISO 8601 UTC.
function icalToIso(v, tz) {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return v;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00', z] = m;
  if (z) return `${y}-${mo}-${d}T${hh}:${mm}:${ss}.000Z`; // already UTC
  if (tz) return wallToUtc(+y, +mo, +d, +hh, +mm, +ss, tz).toISOString(); // TZID → UTC
  // Floating (no Z, no TZID) — no zone info exists; surface as UTC.
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}.000Z`;
}

// Parse VEVENT blocks out of an iCalendar payload (handles ;PARAM on keys).
function parseVEvents(ics) {
  const text = unfold(ics);
  const events = [];
  const re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ev = {};
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const rawKey = line.slice(0, idx);
      const val = line.slice(idx + 1).trim();
      const key = rawKey.split(';')[0].toUpperCase();
      const tzm = rawKey.match(/TZID=([^;]+)/i);
      const tz = tzm ? tzm[1] : undefined;
      if (!val) continue;
      switch (key) {
        case 'UID': ev.uid = val; break;
        case 'SUMMARY': ev.summary = unescapeIcs(val); break;
        case 'DESCRIPTION': ev.description = unescapeIcs(val); break;
        case 'LOCATION': ev.location = unescapeIcs(val); break;
        case 'DTSTART': ev.start = icalToIso(val, tz); break;
        case 'DTEND': ev.end = icalToIso(val, tz); break;
        case 'RRULE': ev.rrule = val; break;
      }
    }
    if (ev.start) events.push(ev);
  }
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return events;
}

function unescapeIcs(s) {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
// Escape a value for an iCalendar/vCard property. CR and LF are BOTH folded to
// the literal `\n` escape and stray C0 control chars are stripped — otherwise a
// crafted --summary/--note/--location containing a raw CR (or LF) could inject
// additional ICS/vCard property lines (Carnot, cage-match PR #115).
function stripCtl(s) {
  let o = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 32 || c === 9 || c === 10 || c === 13) o += ch;
  }
  return o;
}
function escapeIcs(s) {
  return stripCtl(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}
// XML text escaper — used for DAV request bodies (displaynames etc.). Distinct
// from escapeIcs: the grammar boundary is XML, not iCalendar.
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
// Validate an IANA timezone. sanitizeLine alone is insufficient here: `;`/`:`
// are TZID-parameter-significant, so a crafted --tz could alter parameter
// parsing (Carnot, cage-match PR #115 r3). Intl rejects any non-zone string.
function validateTz(tz) {
  const t = sanitizeLine(String(tz));
  try {
    // Throws RangeError on an unrecognized zone (incl. anything with ;/: /spaces).
    new Intl.DateTimeFormat('en-US', { timeZone: t });
  } catch {
    fail(`invalid --tz '${tz}': expected an IANA timezone like Australia/Melbourne`);
  }
  return t;
}

// Strip CR/LF/control chars from a single-line property value (e.g. RRULE).
function sanitizeLine(s) {
  let o = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 32 || c === 9) o += ch;
  }
  return o;
}

// ISO/Date → "YYYYMMDDTHHMMSSZ" (UTC basic, for filters & UTC events).
function toIcalUtc(iso) {
  const d = new Date(iso);
  if (isNaN(d)) fail(`invalid date: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
// ISO/wall → "YYYYMMDDTHHMMSS" (floating, for TZID events — no Z).
function toIcalFloating(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) fail(`invalid local date-time: ${iso} (use YYYY-MM-DDTHH:MM)`);
  const [, y, mo, d, hh, mm, ss = '00'] = m;
  return `${y}${mo}${d}T${hh}${mm}${ss}`;
}

// ── XML helpers (regex-level; Radicale's responses are simple/stable) ────────
function xmlResponses(xml) {
  return [...xml.matchAll(/<[^:>]*:?response\b[\s\S]*?<\/[^:>]*:?response>/gi)].map(
    (r) => r[0],
  );
}
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<[^:>]*:?${tag}\\b[^>]*>([\\s\\S]*?)</[^:>]*:?${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}
function xmlHref(block) {
  const m = block.match(/<[^:>]*:?href\b[^>]*>([\s\S]*?)<\/[^:>]*:?href>/i);
  return m ? m[1].trim() : null;
}
// Decode XML entities. CalDAV/CardDAV embed the iCal/vCard payload as XML TEXT
// inside <calendar-data>/<address-data>, so a SUMMARY/NOTE containing `&`,`<`,`>`
// arrives entity-escaped (&amp; &lt; &gt;) and would otherwise surface verbatim
// in the JSON output ("Tom &amp; Jerry"). Decode `&amp;` LAST so an already-
// escaped entity like `&amp;lt;` round-trips to the literal `&lt;`, not `<`
// (Carnot, cage-match PR #115 r4).
function xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}
// Pull the entity-decoded text content of every <…:calendar-data>/<…:address-data>
// element out of a DAV REPORT response, ready for iCal/vCard parsing. Used only
// for REPORT responses (list-events/list-contacts); GET responses return a raw
// iCal/vCard body and must NOT be entity-decoded.
function extractDavData(xml, tag) {
  const re = new RegExp(`<[^:>]*:?${tag}\\b[^>]*>([\\s\\S]*?)</[^:>]*:?${tag}>`, 'gi');
  let out = '';
  let m;
  while ((m = re.exec(xml)) !== null) out += xmlDecode(m[1]) + '\n';
  return out;
}

// ── verbs ──────────────────────────────────────────────────────────────────
async function listCalendars(auth, opts) {
  const user = encodeURIComponent(opts.user || auth.username);
  const url = `${auth.base}/${user}/`;
  const body =
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>';
  const { text } = await dav('PROPFIND', url, auth, { body, depth: 1, contentType: 'application/xml' });
  const cals = [];
  for (const r of xmlResponses(text)) {
    const href = xmlHref(r);
    if (!href || /calendar/i.test(xmlTag(r, 'resourcetype') || '') === false) {
      // keep only calendar collections
      if (!/<[^:>]*:?calendar\b/i.test(r)) continue;
    }
    cals.push({ url: href, name: xmlTag(r, 'displayname') || '' });
  }
  return cals.filter((c) => c.url && !c.url.replace(/\/$/, '').endsWith(`/${user}`));
}

async function listEvents(auth, opts) {
  const url = calUrl(auth.base, opts.calendar);
  if (!url) fail('--calendar <url-or-path> is required for list-events');
  const from = opts.from ? new Date(opts.from) : new Date();
  const to = opts.to
    ? new Date(opts.to)
    : new Date(Date.now() + (Number(opts.days || 90)) * 864e5);
  const s = toIcalUtc(from.toISOString());
  const e = toIcalUtc(to.toISOString());
  const body =
    '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `<d:prop><c:calendar-data><c:expand start="${s}" end="${e}"/></c:calendar-data></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    `<c:time-range start="${s}" end="${e}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const { text } = await dav('REPORT', url, auth, { body, depth: 1, contentType: 'application/xml' });
  // Each <response> carries an expanded VEVENT instance as XML-escaped text in
  // its <calendar-data>; entity-decode it before iCal parsing so `&`,`<`,`>` in
  // a SUMMARY/DESCRIPTION don't leak as &amp;/&lt;/&gt; (Carnot, PR #115 r4).
  const events = parseVEvents(extractDavData(text, 'calendar-data'));
  return events.map((e2) => ({
    uid: e2.uid,
    summary: e2.summary || '',
    description: e2.description || '',
    start: e2.start,
    end: e2.end || null,
    location: e2.location || '',
  }));
}

function buildVEvent(opts) {
  // uid + tz are interpolated into property keys/values, not escapable bodies —
  // sanitize to single-line tokens so a crafted --uid/--tz can't inject extra
  // ICS lines (Carnot, cage-match PR #115; same family as the CR/LF fix).
  const uid = sanitizeLine(opts.uid || `radicale-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const tz = opts.tz ? validateTz(opts.tz) : undefined;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//radicale-cli//radicale-cli//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcalUtc(new Date().toISOString())}`,
  ];
  if (tz) {
    lines.push(`DTSTART;TZID=${tz}:${toIcalFloating(opts.start)}`);
    if (opts.end) lines.push(`DTEND;TZID=${tz}:${toIcalFloating(opts.end)}`);
  } else {
    lines.push(`DTSTART:${toIcalUtc(opts.start)}`);
    if (opts.end) lines.push(`DTEND:${toIcalUtc(opts.end)}`);
  }
  lines.push(`SUMMARY:${escapeIcs(opts.summary)}`);
  if (opts.location) lines.push(`LOCATION:${escapeIcs(opts.location)}`);
  if (opts.description) lines.push(`DESCRIPTION:${escapeIcs(opts.description)}`);
  if (opts.rrule) {
    lines.push(`RRULE:${sanitizeLine(opts.rrule.replace(/^RRULE:/i, ''))}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return { uid, ics: lines.join('\r\n') };
}

async function addEvent(auth, opts) {
  const url = calUrl(auth.base, opts.calendar);
  if (!url) fail('--calendar is required');
  if (!opts.summary || !opts.start) fail('--summary and --start are required');
  const { uid, ics } = buildVEvent(opts);
  await dav('PUT', `${url}${encodeURIComponent(uid)}.ics`, auth, {
    body: ics,
    contentType: 'text/calendar; charset=utf-8',
  });
  return { uid, calendar: url, status: 'created' };
}

async function deleteEvent(auth, opts) {
  const url = calUrl(auth.base, opts.calendar);
  if (!url || !opts.uid) fail('--calendar and --uid are required');
  await dav('DELETE', `${url}${encodeURIComponent(opts.uid)}.ics`, auth, {});
  return { uid: opts.uid, status: 'deleted' };
}

async function getEvent(auth, opts) {
  const url = calUrl(auth.base, opts.calendar);
  if (!url || !opts.uid) fail('--calendar and --uid are required');
  const { text } = await dav('GET', `${url}${encodeURIComponent(opts.uid)}.ics`, auth, {});
  return parseVEvents(text)[0] || null;
}

async function mkcalendar(auth, opts) {
  const url = calUrl(auth.base, opts.calendar);
  if (!url) fail('--calendar is required');
  const name = opts.name || 'Calendar';
  const body =
    '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `<d:set><d:prop><d:displayname>${escapeXml(name)}</d:displayname></d:prop></d:set></c:mkcalendar>`;
  await dav('MKCALENDAR', url, auth, { body, contentType: 'application/xml' });
  return { calendar: url, name, status: 'created' };
}

// ── CardDAV (contacts) ───────────────────────────────────────────────────────
// vCard property parse (FN/EMAIL/TEL/ORG/TITLE/NOTE/UID), param-tolerant.
function parseVCards(vcf) {
  const text = unfold(vcf);
  const cards = [];
  const re = /BEGIN:VCARD([\s\S]*?)END:VCARD/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const c = {};
    for (const line of m[1].split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).split(';')[0].toUpperCase();
      const val = unescapeIcs(line.slice(idx + 1).trim());
      if (!val) continue;
      switch (key) {
        case 'UID': c.uid = val; break;
        case 'FN': c.fn = val; break;
        case 'EMAIL': c.email = val; break;
        case 'TEL': c.tel = val; break;
        case 'ORG': c.org = val; break;
        case 'TITLE': c.title = val; break;
        case 'NOTE': c.note = val; break;
      }
    }
    if (c.uid || c.fn) cards.push(c);
  }
  cards.sort((a, b) => String(a.fn || '').localeCompare(String(b.fn || '')));
  return cards;
}

function buildVCard(opts) {
  const uid = sanitizeLine(opts.uid || `radicale-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  if (!opts.fn) fail('--fn (full name) is required');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${escapeIcs(opts.fn)}`];
  lines.push(`N:${escapeIcs(opts.n || opts.fn)};;;;`);
  if (opts.email) lines.push(`EMAIL:${escapeIcs(opts.email)}`);
  if (opts.tel) lines.push(`TEL:${escapeIcs(opts.tel)}`);
  if (opts.org) lines.push(`ORG:${escapeIcs(opts.org)}`);
  if (opts.title) lines.push(`TITLE:${escapeIcs(opts.title)}`);
  if (opts.note) lines.push(`NOTE:${escapeIcs(opts.note)}`);
  lines.push('END:VCARD');
  return { uid, vcf: lines.join('\r\n') };
}

// addressbook URL: same-origin absolute, or "<user>/<book>" path under base.
function bookUrl(base, book) {
  return resolveCollection(base, book, '--addressbook');
}

async function listAddressBooks(auth, opts) {
  const user = encodeURIComponent(opts.user || auth.username);
  const url = `${auth.base}/${user}/`;
  const body =
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    '<d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>';
  const { text } = await dav('PROPFIND', url, auth, { body, depth: 1, contentType: 'application/xml' });
  const books = [];
  for (const r of xmlResponses(text)) {
    if (!/<[^:>]*:?addressbook\b/i.test(r)) continue; // carddav addressbook resourcetype
    const href = xmlHref(r);
    if (href) books.push({ url: href, name: xmlTag(r, 'displayname') || '' });
  }
  return books;
}

async function mkaddressbook(auth, opts) {
  const url = bookUrl(auth.base, opts.addressbook);
  if (!url) fail('--addressbook <url|path> is required');
  const name = opts.name || 'Address Book';
  const body =
    '<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    '<d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>' +
    `<d:displayname>${escapeXml(name)}</d:displayname></d:prop></d:set></d:mkcol>`;
  await dav('MKCOL', url, auth, { body, contentType: 'application/xml' });
  return { addressbook: url, name, status: 'created' };
}

async function listContacts(auth, opts) {
  const url = bookUrl(auth.base, opts.addressbook);
  if (!url) fail('--addressbook is required');
  const body =
    '<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    '<d:prop><card:address-data/></d:prop></card:addressbook-query>';
  const { text } = await dav('REPORT', url, auth, { body, depth: 1, contentType: 'application/xml' });
  // <address-data> carries the vCard as XML-escaped text — decode entities
  // before vCard parsing (Carnot, PR #115 r4).
  return parseVCards(extractDavData(text, 'address-data'));
}

async function addContact(auth, opts) {
  const url = bookUrl(auth.base, opts.addressbook);
  if (!url) fail('--addressbook is required');
  const { uid, vcf } = buildVCard(opts);
  await dav('PUT', `${url}${encodeURIComponent(uid)}.vcf`, auth, {
    body: vcf,
    contentType: 'text/vcard; charset=utf-8',
  });
  return { uid, addressbook: url, status: 'saved' };
}

// update-contact is a PUT-by-uid (full replace), so it MUST carry --uid. Without
// one, addContact would mint a fresh UID and silently CREATE a duplicate instead
// of updating — fail closed so a kickstart "update" can't fork a profile
// (Carnot, cage-match PR #115 r4).
async function updateContact(auth, opts) {
  if (!opts.uid) {
    fail('--uid is required for update-contact (it identifies the card to ' +
      'replace; without it use add-contact to create a new one).');
  }
  return addContact(auth, opts);
}

async function getContact(auth, opts) {
  const url = bookUrl(auth.base, opts.addressbook);
  if (!url || !opts.uid) fail('--addressbook and --uid are required');
  const { text } = await dav('GET', `${url}${encodeURIComponent(opts.uid)}.vcf`, auth, {});
  return parseVCards(text)[0] || null;
}

async function deleteContact(auth, opts) {
  const url = bookUrl(auth.base, opts.addressbook);
  if (!url || !opts.uid) fail('--addressbook and --uid are required');
  await dav('DELETE', `${url}${encodeURIComponent(opts.uid)}.vcf`, auth, {});
  return { uid: opts.uid, status: 'deleted' };
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────
function fail(msg) {
  process.stderr.write(`radicale: ${msg}\n`);
  process.exit(1);
}

const HELP = `radicale — CalDAV CLI for Radicale

USAGE
  radicale <command> [--site <name>] [options]

COMMANDS
  list-calendars  [--user <name>]
  list-events     --calendar <url|path> [--from <ISO>] [--to <ISO>] [--days N]
  add-event       --calendar <url|path> --summary <s> --start <ISO|local>
                  [--end <ISO|local>] [--tz <IANA>] [--location <l>]
                  [--description <d>] [--rrule <RRULE>] [--uid <id>]
  delete-event    --calendar <url|path> --uid <id>
  get-event       --calendar <url|path> --uid <id>
  mkcalendar      --calendar <url|path> [--name <name>]

  list-address-books [--user <name>]
  mkaddressbook   --addressbook <url|path> [--name <name>]
  list-contacts   --addressbook <url|path>
  add-contact     --addressbook <url|path> --fn <full name> [--email <e>]
                  [--tel <t>] [--org <o>] [--title <t>] [--note <n>] [--uid <id>]
  update-contact  (same flags as add-contact; --uid identifies the card)
  get-contact     --addressbook <url|path> --uid <id>
  delete-contact  --addressbook <url|path> --uid <id>

NOTES
  * list-events expands recurrence + timezones SERVER-SIDE (RFC 4791 expand);
    output is JSON [{uid,summary,description,start,end,location}] in UTC.
  * --tz makes add-event use a floating wall-clock with TZID (e.g.
    --start 2026-06-27T15:00 --tz Australia/Melbourne). Without --tz, --start
    is parsed as an absolute instant and stored as UTC.
  * --calendar accepts a full URL or a "<user>/<calendar>" path under the site.

AUTH (env)
  RADICALE_<SITE>_USERNAME/PASSWORD  or  RADICALE_USERNAME/PASSWORD
  RADICALE_BASE_URL  (overrides the --site base URL)

EXAMPLES
  radicale list-events --calendar me/my-calendar
  radicale add-event --calendar me/my-calendar --summary "Build session" \\
    --start 2026-07-04T15:00 --end 2026-07-04T18:00 --tz Australia/Melbourne \\
    --location "Room 1"
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    process.exit(cmd ? 0 : 1);
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      site: { type: 'string', default: 'example' },
      calendar: { type: 'string' },
      user: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      days: { type: 'string' },
      summary: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      tz: { type: 'string' },
      location: { type: 'string' },
      description: { type: 'string' },
      rrule: { type: 'string' },
      uid: { type: 'string' },
      name: { type: 'string' },
      addressbook: { type: 'string' },
      fn: { type: 'string' },
      n: { type: 'string' },
      email: { type: 'string' },
      tel: { type: 'string' },
      org: { type: 'string' },
      title: { type: 'string' },
      note: { type: 'string' },
    },
    allowPositionals: true,
  });
  const auth = resolveAuth(values.site);
  const verbs = {
    'list-calendars': listCalendars,
    'list-events': listEvents,
    'add-event': addEvent,
    'delete-event': deleteEvent,
    'get-event': getEvent,
    mkcalendar,
    // CardDAV (contacts) — add-contact handles create AND update (PUT by uid).
    'list-address-books': listAddressBooks,
    mkaddressbook,
    'list-contacts': listContacts,
    'add-contact': addContact,
    'update-contact': updateContact,
    'get-contact': getContact,
    'delete-contact': deleteContact,
  };
  const fn = verbs[cmd];
  if (!fn) fail(`unknown command: ${cmd} (try --help)`);
  const out = await fn(auth, values);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => fail(e.stack || e.message));
