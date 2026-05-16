#!/usr/bin/env node
// Requires Node.js 18+ (uses built-in fetch)
// Usage: MAPBOX_TOKEN=pk.xxx node scripts/geocode.js

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TOKEN = process.env.MAPBOX_TOKEN;
if (!TOKEN) {
  console.error('ERROR: MAPBOX_TOKEN environment variable is not set.');
  console.error('  PowerShell: $env:MAPBOX_TOKEN = "pk.xxx..."');
  console.error('  bash:       export MAPBOX_TOKEN="pk.xxx..."');
  process.exit(1);
}

// ── CSV parser (handles quoted fields with embedded commas) ──────────────────
function parseCsv(text) {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] ?? '').trim(); });
    rows.push(obj);
  }
  return rows;
}

function splitLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQ = !inQ;
    } else if (line[i] === ',' && !inQ) {
      fields.push(cur);
      cur = '';
    } else {
      cur += line[i];
    }
  }
  fields.push(cur);
  return fields;
}

// ── Mapbox Geocoding API v5 ──────────────────────────────────────────────────
async function geocode(query) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
    + `?access_token=${TOKEN}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!data.features || data.features.length === 0) return null;
  const f = data.features[0];
  return {
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    relevance: f.relevance,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isUsable(addr) {
  return addr && addr.trim() && addr.trim().toUpperCase() !== 'TBD';
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = join(ROOT, 'data', 'teams.csv');
  const outPath = join(ROOT, 'data', 'teams.json');

  const rows = parseCsv(readFileSync(csvPath, 'utf-8'));
  const valid = rows.filter(r => r.team && r.team.trim());
  console.log(`Processing ${valid.length} teams…\n`);

  const results = [];
  const warnings = [];

  for (const row of valid) {
    const candidates = [];
    if (isUsable(row.training_address)) candidates.push({ addr: row.training_address, src: 'training_address' });
    if (isUsable(row.hotel_address))    candidates.push({ addr: row.hotel_address,    src: 'hotel_address' });
    candidates.push({ addr: `${row.team} national football team`, src: 'team_name_fallback' });

    let best = null;
    let bestSrc = null;

    for (const { addr, src } of candidates) {
      let result;
      try {
        result = await geocode(addr);
      } catch (err) {
        console.warn(`  [${row.team}] API error on "${src}": ${err.message}`);
        await sleep(250);
        continue;
      }
      await sleep(250);

      if (!result) continue;

      if (!best || result.relevance > best.relevance) {
        best = result;
        bestSrc = src;
      }
      if (result.relevance >= 0.5) break; // good enough, stop trying
    }

    if (!best) {
      console.warn(`  ⚠ [${row.team}] Could not geocode — all candidates returned no results`);
      results.push({ ...row, lng: null, lat: null, geocode_relevance: null, geocode_source: null });
      continue;
    }

    const entry = {
      ...row,
      lng: best.lng,
      lat: best.lat,
      geocode_relevance: best.relevance,
      geocode_source: bestSrc,
    };
    results.push(entry);

    const flag = best.relevance < 0.7 ? ' ⚠ LOW RELEVANCE' : '';
    console.log(`  ✓ [${row.team}] ${bestSrc} → (${best.lng.toFixed(4)}, ${best.lat.toFixed(4)}) rel=${best.relevance.toFixed(2)}${flag}`);

    if (best.relevance < 0.7) {
      warnings.push({ team: row.team, src: bestSrc, relevance: best.relevance });
    }
  }

  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8');
  console.log(`\nWrote ${results.length} records → data/teams.json`);

  if (warnings.length > 0) {
    console.warn(`\n⚠ ${warnings.length} teams with geocode_relevance < 0.7 (may need manual review):`);
    warnings.forEach(w =>
      console.warn(`  ${w.team.padEnd(25)} src=${w.src.padEnd(20)} rel=${w.relevance.toFixed(2)}`)
    );
  } else {
    console.log('✓ All teams geocoded with relevance ≥ 0.7');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
