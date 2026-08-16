#!/usr/bin/env node

/**
 * sync.js — Fetches ICS feeds from a Google Sheet CSV config,
 * parses events, and writes events.json, events.csv, and events.ics
 */

const fs = require("fs");
const path = require("path");

const FEEDS_CSV_PATH = path.join(__dirname, "plsd-ics.csv");

// gofmx-wide feed of deleted/cancelled requests — used to exclude events that
// linger in a category feed (or a stale fetch) after being deleted upstream.
const DELETED_FEED_URL = "https://polandschools.gofmx.com/calendar.ics?t3=bRw1WguLlK69Xl_tmRssV3KHc8Q1Tx5-X33N_ksnRT_7s2RNiAEbvfcOLb4zzJ-P6AvGAWY_29n6R2vYFBWtIwnczjzka1GfF9ADKtLWIZ4p2SyXpZSRgnAKwe0tGrDh";

const OUTPUT_DIR = path.join(__dirname, "output");
const TIMEZONE = "America/New_York";

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// CSV parser (feeds config)
// ---------------------------------------------------------------------------

function parseFeedsCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map((h) => h.trim());
  const idxCategory = headers.indexOf("Request Type");
  const idxUrl = headers.indexOf("ICS Link");
  const idxColor = headers.indexOf("Color");

  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(",").map((c) => c.trim());
    if (row.length < 2) continue;
    const category = row[idxCategory];
    const url = row[idxUrl];
    const color = row[idxColor] || "";
    if (category && url) result.push({ category, url, color });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Date formatter — mirrors Apps Script formatDate()
// ---------------------------------------------------------------------------

function formatDate(raw, isEnd = false) {
  if (!raw) return "";
  const cleanRaw = raw.split(":").pop().trim();

  let year = parseInt(cleanRaw.slice(0, 4));
  let month = parseInt(cleanRaw.slice(4, 6)) - 1;
  let day = parseInt(cleanRaw.slice(6, 8));

  // All-day (DATE-only, YYYYMMDD) — this has no attached timezone, so it must
  // be treated as a literal Eastern wall-clock date, not run through a
  // system-local Date object (that round-trip shifts it by the UTC offset
  // and can push midnight into the previous calendar day). Per RFC 5545
  // §3.8.2.2, DTEND on a DATE-value VEVENT is exclusive (the day *after*
  // the event's last day), so roll it back one day before formatting.
  if (cleanRaw.length <= 8) {
    if (isEnd) {
      const d = new Date(year, month, day);
      d.setDate(d.getDate() - 1);
      year = d.getFullYear();
      month = d.getMonth();
      day = d.getDate();
    }
    const hour = isEnd ? 23 : 0;
    const minute = isEnd ? 59 : 0;
    return formatEasternDateString(year, month, day, hour, minute);
  }

  // Timed (YYYYMMDDTHHMMSSZ)
  const hour = parseInt(cleanRaw.slice(9, 11));
  const minute = parseInt(cleanRaw.slice(11, 13));
  const utcDate = new Date(Date.UTC(year, month, day, hour, minute));
  return toEasternString(utcDate);
}

// Formats a literal Eastern-time wall-clock date (no timezone conversion) —
// used for all-day values, which don't correspond to a real UTC instant.
function formatEasternDateString(year, month, day, hour, minute) {
  const pad2 = (n) => String(n).padStart(2, "0");
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${year}-${pad2(month + 1)}-${pad2(day)} ${h12}:${pad2(minute)} ${ampm}`;
}

function toEasternString(date) {
  // Format: yyyy-MM-dd h:mm a  in America/New_York
  return date.toLocaleString("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).replace(/(\d+)\/(\d+)\/(\d+),\s*/, "$3-$1-$2 ");
}

// ---------------------------------------------------------------------------
// Location cleaner
// ---------------------------------------------------------------------------

function cleanLocation(location) {
  if (!location) return "";
  if (location.includes(">")) location = location.split(">").pop().trim();
  location = location.replace(/\s*\([^)]*\)$/, "").trim();
  return location;
}

// ---------------------------------------------------------------------------
// ICS parser
// ---------------------------------------------------------------------------

function parseIcs(text, feed) {
  const rawEvents = text.split("BEGIN:VEVENT").slice(1);
  const events = [];

  for (const block of rawEvents) {
    // Unfold continuation lines (RFC 5545 §3.1)
    const unfolded = block.replace(/\r?\n[ \t]/g, "");
    const lines = unfolded.split(/\r?\n/);
    const event = { type: feed.category, color: feed.color };

    for (const line of lines) {
      if (line.startsWith("UID")) {
        event.uid = line.split(":").slice(1).join(":").trim();
        const match = event.uid.match(/request-(\d+)-occurrence-(\d+)/);
        if (match) {
          event.link = `https://polandschools.gofmx.com/scheduling/requests/${match[1]}/occurrences/${match[2]}`;
        }
      }
      if (line.startsWith("SUMMARY")) {
        const rawSummary = line.split(":").slice(1).join(":").trim();
        event.summary = rawSummary;
        event.title = rawSummary;
      }
      if (line.startsWith("DTSTART")) {
        event.start = formatDate(line, false);
        event._dtstart = line.split(":").pop().trim(); // keep raw for ICS output
      }
      if (line.startsWith("DTEND")) {
        event.end = formatDate(line, true);
        event._dtend = line.split(":").pop().trim();

        // Fix timed "midnight-start" events (FMX all-day/TBA encoding: 12 AM – 2 AM)
        if (event.start && event.start.endsWith("12:00 AM")) {
          const s = event.start.split("-");
          event.end = toEasternString(
            new Date(parseInt(s[0]), parseInt(s[1]) - 1, parseInt(s[2]), 23, 59)
          );
        }
      }
      if (line.startsWith("LOCATION")) {
        const rawLoc = line.split(":").slice(1).join(":")
          .replace(/\\n/g, " ").replace(/\\,/g, ",").trim();
        event.location = cleanLocation(rawLoc);
      }
    }

    if (event.summary && event.start) events.push(event);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Deleted-events feed
// ---------------------------------------------------------------------------

function parseDeletedUids(text) {
  const uids = new Set();
  const rawEvents = text.split("BEGIN:VEVENT").slice(1);
  for (const block of rawEvents) {
    const unfolded = block.replace(/\r?\n[ \t]/g, "");
    const match = unfolded.match(/^UID:(.+)$/m);
    if (match) uids.add(match[1].trim());
  }
  return uids;
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

const TRACKED_FIELDS = ["title", "start", "end", "location", "type", "color"];

function generateDiff(oldEvents, newEvents) {
  const oldByUid = new Map(oldEvents.filter(e => e.uid).map(e => [e.uid, e]));
  const newByUid = new Map(newEvents.filter(e => e.uid).map(e => [e.uid, e]));

  const added = [];
  const removed = [];
  const edited = [];

  for (const [uid, ev] of newByUid) {
    if (!oldByUid.has(uid)) {
      added.push({ uid, title: ev.title, type: ev.type, start: ev.start, end: ev.end });
    } else {
      const old = oldByUid.get(uid);
      const changes = {};
      for (const field of TRACKED_FIELDS) {
        const oldVal = old[field] || "";
        const newVal = ev[field] || "";
        if (oldVal !== newVal) changes[field] = { from: oldVal, to: newVal };
      }
      if (Object.keys(changes).length > 0) {
        edited.push({ uid, title: ev.title, type: ev.type, start: ev.start, end: ev.end, changes });
      }
    }
  }

  for (const [uid, ev] of oldByUid) {
    if (!newByUid.has(uid)) {
      removed.push({ uid, title: ev.title, type: ev.type, start: ev.start, end: ev.end });
    }
  }

  return { added, removed, edited };
}

function appendChangelog(diff) {
  const changelogPath = path.join(OUTPUT_DIR, "changelog.json");
  let entries = [];
  if (fs.existsSync(changelogPath)) {
    try { entries = JSON.parse(fs.readFileSync(changelogPath, "utf8")); } catch {}
  }
  entries.unshift({
    timestamp: new Date().toISOString(),
    added: diff.added,
    removed: diff.removed,
    edited: diff.edited,
  });
  if (entries.length > 200) entries = entries.slice(0, 200);
  fs.writeFileSync(changelogPath, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// Output writers
// ---------------------------------------------------------------------------

const CSV_HEADERS = ["uid", "title", "summary", "type", "color", "start", "end", "location", "link"];

function writeJson(events) {
  const out = events.map((e) => {
    const obj = {};
    CSV_HEADERS.forEach((h) => { obj[h] = e[h] || ""; });
    return obj;
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, "events.json"), JSON.stringify(out, null, 2));
}

function escapeCsv(val) {
  if (val == null) return "";
  let s = String(val);
  // Neutralize leading formula-trigger chars so Excel/Sheets don't execute them.
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(events) {
  const rows = [CSV_HEADERS.join(",")];
  for (const e of events) {
    rows.push(CSV_HEADERS.map((h) => escapeCsv(e[h] || "")).join(","));
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, "events.csv"), rows.join("\n"));
}

// Strip CR/LF so a value from an external ICS feed can't inject new iCal lines.
function icalRaw(val) {
  return String(val ?? "").replace(/[\r\n]/g, "");
}

// Strip CR/LF and apply RFC 5545 §3.3.11 text escaping.
function icalText(val) {
  return icalRaw(val)
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function writeIcs(events) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Poland Schools Calendar Sync//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:Poland Schools Events`,
    `X-WR-TIMEZONE:${TIMEZONE}`,
  ];

  for (const e of events) {
    lines.push("BEGIN:VEVENT");
    if (e.uid)      lines.push(`UID:${icalRaw(e.uid)}`);
    if (e._dtstart) lines.push(`DTSTART:${icalRaw(e._dtstart)}`);
    if (e._dtend)   lines.push(`DTEND:${icalRaw(e._dtend)}`);
    if (e.summary)  lines.push(`SUMMARY:${icalText(e.summary)}`);
    if (e.location) lines.push(`LOCATION:${icalText(e.location)}`);
    if (e.type)     lines.push(`CATEGORIES:${icalText(e.type)}`);
    if (e.link)     lines.push(`URL:${icalRaw(e.link)}`);
    lines.push(`X-COLOR:${icalRaw(e.color || "")}`);
    lines.push(`DTSTAMP:${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  fs.writeFileSync(path.join(OUTPUT_DIR, "events.ics"), lines.join("\r\n"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("📥 Reading feeds config CSV…");
  const csvText = fs.readFileSync(FEEDS_CSV_PATH, "utf8");
  const feeds = parseFeedsCsv(csvText);
  console.log(`   Found ${feeds.length} feed(s)`);

  // Load previous events for diffing before we overwrite
  const eventsJsonPath = path.join(OUTPUT_DIR, "events.json");
  let previousEvents = [];
  if (fs.existsSync(eventsJsonPath)) {
    try { previousEvents = JSON.parse(fs.readFileSync(eventsJsonPath, "utf8")); } catch {}
  }

  const allEvents = [];

  for (const feed of feeds) {
    try {
      console.log(`📅 Fetching [${feed.category}]…`);
      const text = await fetchText(feed.url);
      const events = parseIcs(text, feed);
      console.log(`   → ${events.length} event(s)`);
      allEvents.push(...events);
    } catch (err) {
      console.error(`❌ Error fetching ${feed.category}: ${err.message}`);
    }
  }

  console.log(`\n✅ Total events: ${allEvents.length}`);

  // Filter out anything that gofmx reports as deleted (belt-and-suspenders
  // against a category feed lagging behind a deletion, or a duplicate
  // request that was cloned-and-abandoned instead of edited in place).
  let filteredEvents = allEvents;
  try {
    console.log("🗑️  Fetching deleted-events feed…");
    const deletedText = await fetchText(DELETED_FEED_URL);
    const deletedUids = parseDeletedUids(deletedText);
    console.log(`   → ${deletedUids.size} deleted UID(s)`);
    filteredEvents = allEvents.filter((e) => !e.uid || !deletedUids.has(e.uid));
    const removedCount = allEvents.length - filteredEvents.length;
    if (removedCount > 0) console.log(`   → excluded ${removedCount} event(s) present in a category feed but marked deleted`);
  } catch (err) {
    console.error(`❌ Error fetching deleted-events feed: ${err.message}`);
  }

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Diff and write changelog (skip on first run when there's nothing to compare)
  if (previousEvents.length > 0) {
    const normalised = filteredEvents.map(e => {
      const obj = {};
      CSV_HEADERS.forEach(h => { obj[h] = e[h] || ""; });
      return obj;
    });
    const diff = generateDiff(previousEvents, normalised);
    const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.edited.length > 0;
    if (hasChanges) {
      console.log(`📋 Changes: +${diff.added.length} added  -${diff.removed.length} removed  ~${diff.edited.length} edited`);
      appendChangelog(diff);
    } else {
      console.log("📋 No event changes detected");
    }
  }

  writeJson(filteredEvents);
  writeCsv(filteredEvents);
  writeIcs(filteredEvents);

  console.log("📁 Written: output/events.json, output/events.csv, output/events.ics");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
