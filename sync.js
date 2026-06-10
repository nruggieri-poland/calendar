#!/usr/bin/env node

/**
 * sync.js — Fetches ICS feeds from a Google Sheet CSV config,
 * parses events, and writes events.json, events.csv, and events.ics
 */

const fs = require("fs");
const path = require("path");

const FEEDS_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSATVO6MeraRQxM9TyiEOduUpTtrliflsQEzwmOGAxXFGLH3MOLCkC9RIH76FfAuf4dj4UkzmrKKPsL/pub?output=csv";

const OUTPUT_DIR = path.join(__dirname, "output");
const TIMEZONE = "America/New_York";

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
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
  const s = String(val);
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
    if (e.uid)      lines.push(`UID:${e.uid}`);
    if (e._dtstart) lines.push(`DTSTART:${e._dtstart}`);
    if (e._dtend)   lines.push(`DTEND:${e._dtend}`);
    if (e.summary)  lines.push(`SUMMARY:${e.summary.replace(/,/g, "\\,")}`);
    if (e.location) lines.push(`LOCATION:${e.location.replace(/,/g, "\\,")}`);
    if (e.type)     lines.push(`CATEGORIES:${e.type}`);
    if (e.link)     lines.push(`URL:${e.link}`);
    lines.push(`X-COLOR:${e.color || ""}`);
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
  console.log("📥 Fetching feeds config CSV…");
  const csvText = await fetchText(FEEDS_CSV_URL);
  const feeds = parseFeedsCsv(csvText);
  console.log(`   Found ${feeds.length} feed(s)`);

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

  writeJson(allEvents);
  writeCsv(allEvents);
  writeIcs(allEvents);

  console.log("📁 Written: output/events.json, output/events.csv, output/events.ics");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
