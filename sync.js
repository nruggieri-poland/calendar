#!/usr/bin/env node

/**
 * sync.js — Fetches ICS feeds from a Google Sheet CSV config,
 * parses events, and writes events.json, events.csv, and events.ics
 */

const fs = require("fs");
const path = require("path");

const FEEDS_CSV_PATH = path.join(__dirname, "plsd-ics.csv");

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

  const year = parseInt(cleanRaw.slice(0, 4));
  const month = parseInt(cleanRaw.slice(4, 6)) - 1;
  const day = parseInt(cleanRaw.slice(6, 8));

  // All-day (YYYYMMDD)
  if (cleanRaw.length <= 8) {
    const hour = isEnd ? 23 : 0;
    const minute = isEnd ? 59 : 0;
    const d = new Date(year, month, day, hour, minute, 0);
    return toEasternString(d);
  }

  // Timed (YYYYMMDDTHHMMSSZ)
  const hour = parseInt(cleanRaw.slice(9, 11));
  const minute = parseInt(cleanRaw.slice(11, 13));
  const utcDate = new Date(Date.UTC(year, month, day, hour, minute));
  return toEasternString(utcDate);
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

        // Fix ICS "next-day" all-day end dates (DATE-only DTEND)
        if (event.start && event.end && !line.includes("T")) {
          const startDatePart = event.start.split(" ")[0];
          const endDatePart = event.end.split(" ")[0];
          if (startDatePart !== endDatePart) {
            const s = event.start.split("-");
            const corrected = new Date(
              parseInt(s[0]), parseInt(s[1]) - 1, parseInt(s[2]), 23, 59
            );
            event.end = toEasternString(corrected);
            event._dtend = null; // signal to use original for ICS
          }
        }

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

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Diff and write changelog (skip on first run when there's nothing to compare)
  if (previousEvents.length > 0) {
    const normalised = allEvents.map(e => {
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

  writeJson(allEvents);
  writeCsv(allEvents);
  writeIcs(allEvents);

  console.log("📁 Written: output/events.json, output/events.csv, output/events.ics");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
