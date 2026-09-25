#!/usr/bin/env node
/*
 * bandcamp-covers.js — find full-resolution album cover art on Bandcamp.
 *
 * Requires Node 18+ (built-in fetch). No dependencies.
 *
 * USAGE
 *   node bandcamp-covers.js albums.csv [options]
 *
 * OPTIONS
 *   --download        Save covers for MATCH rows into covers-yyyymmdd-hhmmss/ and check their pixel size
 *   --include-check   With --download, also save covers for CHECK rows
 *   --delay <ms>      Delay between search requests (default 1000)
 *   --out <file>      Results file (default results-yyyymmdd-hhmmss.csv, local time)
 *   --covers <dir>    Download folder (default covers-yyyymmdd-hhmmss, same time as results)
 *   --skip-bad-rows   Search the good rows even if some rows have problems
 *
 * INPUT
 *   UTF-8 CSV with a header row containing the columns artist,album. Other columns are
 *   ignored. Put quotes around any name that contains a comma: nuclear winter,"hail, satan"
 *
 *   The whole file is checked before any searches, and every problem is listed with its
 *   line number. Wrong column counts, blank names, unclosed quotes, a missing header, and
 *   non-UTF-8, Excel or tab-separated files stop the run (--skip-bad-rows searches the
 *   rest and lists bad rows as INVALID). Duplicates, stray quotes, invisible characters,
 *   and names that can't match are warnings only.
 *
 * OUTPUT
 *   results-yyyymmdd-hhmmss.csv (or --out) with the columns artist, album, status,
 *   matched_artist, matched_album, page_url, cover_url, width, height.
 *   Status: MATCH (score >= 4), CHECK (2-3, review by eye), NO MATCH, ERROR,
 *   TOO SMALL (downloaded, but the shorter side is under 1600px), or INVALID
 *   (a bad row skipped with --skip-bad-rows).
 *
 * NOTES
 *   Uses Bandcamp's undocumented search-box endpoint, which can change without notice.
 *   Response shape verified 2026-09-24: { auto: { results: [ { type, name, band_name,
 *   item_url_path, img, art_id, ... } ] } }.
 *   The original upload is at https://f4.bcbits.com/img/a<art_id, 10 digits>_0.jpg.
 *   The "a" prefix is required. The img field omits it, so changing only its
 *   size suffix returns a 404.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SEARCH_URL = 'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic';
const MIN_SIZE = 1600;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- args ----------

// Local time, yyyymmdd-hhmmss. Shared by the default results file and covers folder.
function timestamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const USAGE = 'Usage: node bandcamp-covers.js albums.csv [--download] [--include-check] [--skip-bad-rows] [--delay ms] [--out file] [--covers dir]';

// Errors the user can fix. main() prints just the message, no stack trace.
function fail(msg) {
  const e = new Error(msg);
  e.userError = true;
  throw e;
}

function parseArgs(argv) {
  const opts = { csv: null, download: false, includeCheck: false, skipBad: false, delay: 1000, out: null, covers: null };
  const value = (i, name, example) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) fail(`${name} needs a value after it, e.g. ${name} ${example}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--download') opts.download = true;
    else if (a === '--include-check') opts.includeCheck = true;
    else if (a === '--skip-bad-rows') opts.skipBad = true;
    else if (a === '--delay') {
      const v = value(++i, a, '1000');
      if (!/^\d+$/.test(v)) fail(`--delay must be a whole number of milliseconds, e.g. --delay 1000 (got "${v}").`);
      opts.delay = Number(v);
    }
    else if (a === '--out') opts.out = value(++i, a, 'results.csv');
    else if (a === '--covers') opts.covers = value(++i, a, 'covers');
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) fail(`Unknown option "${a}".\n${USAGE}`);
    else if (opts.csv) fail(`Only one input file can be given, but got "${opts.csv}" and "${a}".\nIf the file name has spaces in it, put quotes around it: "my albums.csv"`);
    else opts.csv = a;
  }
  if (!opts.csv) fail(`No input file given.\n${USAGE}`);
  if (opts.includeCheck && !opts.download) console.log('Warning: --include-check does nothing without --download.');
  const ts = timestamp();
  if (!opts.out) opts.out = `results-${ts}.csv`;
  if (!opts.covers) opts.covers = `covers-${ts}`;
  return opts;
}

// ---------- CSV ----------

// Reads the input file as text, stopping with a clear message if it isn't a UTF-8 text file.
function readInput(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch { fail(`Can't find the input file "${file}". Check the path and spelling.`); }
  if (stat.isDirectory()) fail(`"${file}" is a folder, not a file. Give the path to the CSV file itself.`);
  if (stat.size === 0) fail(`The input file "${file}" is empty.`);

  const buf = fs.readFileSync(file);
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    fail(`"${file}" is an Excel (.xlsx) or other zipped file, not a CSV.\nIn Excel, use File > Save As and choose "CSV UTF-8 (Comma delimited)".`);
  }
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) {
    fail(`"${file}" is saved as UTF-16 text, which this script can't read.\nRe-save it as "CSV UTF-8" (in Excel) or with UTF-8 encoding (in a text editor).`);
  }
  if (buf.includes(0)) fail(`"${file}" contains binary data, so it isn't a plain-text CSV file.`);

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Find the first line with bytes that aren't valid UTF-8 so the message can point at it.
    let line = 1, start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(start, i)); }
        catch { break; }
        line++; start = i + 1;
      }
    }
    fail(`"${file}" isn't UTF-8 text (first bad character on line ${line}: ${buf.subarray(start, buf.indexOf(0x0a, start) + 1 || buf.length).toString('latin1').trim()}).\n` +
      `This usually means it was saved as plain "CSV" instead of "CSV UTF-8", which garbles accented letters like ö or é.\n` +
      `Re-save it as "CSV UTF-8" (in Excel) or with UTF-8 encoding (in a text editor).`);
  }
}

// Parses CSV text into rows of { fields, line, raw }. Blank lines are skipped. Anything
// malformed goes into `problems` as { line, level: 'error' | 'warning', msg }.
function parseCsv(text) {
  const rows = [], problems = [];
  let fields = [], field = '', inQuotes = false, closedQuote = false, rowError = null;
  let line = 1, rowLine = 1, rowStart = 0, quoteLine = 0;
  const flagged = new Set();
  const flag = (level, msg) => {
    if (flagged.has(`${rowLine}:${msg}`)) return;
    flagged.add(`${rowLine}:${msg}`);
    problems.push({ line: rowLine, level, msg });
  };
  const endField = () => { fields.push(field); field = ''; closedQuote = false; };
  const endRow = end => {
    endField();
    if (fields.some(f => f.trim() !== '')) rows.push({ fields, line: rowLine, raw: text.slice(rowStart, end).trim(), error: rowError });
    fields = []; rowError = null;
  };

  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; closedQuote = true; }
      } else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        field += c;
      }
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      const end = i;
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow(end);
      line++; rowLine = line; rowStart = i + 1;
    } else if (closedQuote) {
      // Reported by loadAlbums as a bad row, so --skip-bad-rows skips it.
      if (c !== ' ' && c !== '\t' && !rowError) {
        rowError = 'has text right after a closing quote mark. Put the quotes around the whole name, ' +
          'and write any quote mark inside a name as two: "The ""Heroes"" Album"';
      }
      field += c;
    } else if (c === '"' && field.trim() === '') {
      inQuotes = true; field = ''; quoteLine = line;
    } else {
      if (c === '"') flag('warning', 'has a quote mark in the middle of a name. It will be kept as part of the name.');
      field += c;
    }
  }
  if (inQuotes) {
    const lines = text.split(/\r\n|\r|\n/);
    fail(`Line ${quoteLine}: a quote mark opens a name here but is never closed, so the rest of the file ` +
      `(${lines.length - quoteLine + 1} lines) would be read as one name:\n    ${lines[quoteLine - 1].trim()}\n` +
      `Add the missing closing quote, or remove the opening one.`);
  }
  endRow(text.length);
  return { rows, problems };
}

// Explains why the header row isn't usable, with a guess at the cause.
function headerHelp(head, names) {
  let msg = `The first line of the file must be a header naming the columns, like this:\n    artist,album\n` +
    `but the first line is:\n    ${head.raw}\n`;
  if (head.fields.length === 1 && head.raw.includes('\t')) {
    msg += 'The columns seem to be separated by tabs. Save the file with commas between the columns instead.';
  } else if (head.fields.length === 1 && head.raw.includes(';')) {
    msg += 'The columns seem to be separated by semicolons (Excel does this in some regions). Save the file with commas between the columns instead.';
  } else if (head.fields.length === 1 && head.raw.includes(' - ')) {
    msg += 'This looks like an "artist - album" list rather than a CSV. Change each " - " to a comma and add "artist,album" as the first line.';
  } else if (names.includes('artist') && (names.includes('title') || names.includes('album title'))) {
    msg += 'Rename the album title column to "album".';
  } else if (!names.includes('artist') && !names.includes('album')) {
    msg += 'If that line is an album rather than a header, add the line "artist,album" at the top of the file.';
  } else {
    msg += `The "${names.includes('artist') ? 'album' : 'artist'}" column is missing.`;
  }
  return msg;
}

// Tidies one name from the CSV and warns about anything that will likely stop it from matching.
function cleanName(s, what, line, warn) {
  let v = s;
  if (/[\r\n]/.test(v)) warn(line, `the ${what} has a line break inside it. It will be treated as a space.`);
  if (v.includes('\t')) warn(line, `the ${what} contains a tab character. It will be treated as a space.`);
  if (/[​-‍⁠﻿]/.test(v)) {
    warn(line, `the ${what} contains invisible zero-width characters (often pasted in from a web page). They will be removed.`);
    v = v.replace(/[​-‍⁠﻿]/g, '');
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(v)) {
    warn(line, `the ${what} contains invisible control characters. They will be removed.`);
    v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }
  v = v.replace(/\s+/g, ' ').trim();
  if (v.includes('�')) {
    warn(line, `the ${what} "${v}" contains "�", which means the text was garbled by an earlier encoding conversion. Retype the name.`);
  }
  if (v && !norm(v)) {
    warn(line, `the ${what} "${v}" has no letters or digits, so it can't be matched automatically.`);
  }
  if (v.length > 150) {
    warn(line, `the ${what} is ${v.length} characters long, which usually means rows got merged by a stray quote mark. Check this line and the one above it.`);
  }
  return v;
}

// Turns the parsed CSV into the album list. Stops on problems that make the whole file unusable;
// problems with single rows are collected so they can all be reported at once.
function loadAlbums(text, opts) {
  const { rows, problems } = parseCsv(text);
  const error = (line, msg) => problems.push({ line, level: 'error', msg });
  const warn = (line, msg) => problems.push({ line, level: 'warning', msg });

  if (!rows.length) fail('The input file only contains blank lines.');
  const head = rows[0];
  const names = head.fields.map(h => h.trim().toLowerCase());
  const ai = names.indexOf('artist'), bi = names.indexOf('album');
  if (ai < 0 || bi < 0) fail(headerHelp(head, names));
  for (const n of ['artist', 'album']) {
    if (names.filter(x => x === n).length > 1) fail(`The header has more than one "${n}" column:\n    ${head.raw}\nRename or remove the extra one.`);
  }
  if (rows.length === 1) fail('The input file has a header line but no albums under it.');

  const albums = [], seen = new Map(), files = new Map();
  for (const row of rows.slice(1)) {
    const f = row.fields;
    const bad = msg => { error(row.line, `${msg}\n    ${row.raw}`); albums.push({ line: row.line, artist: row.raw, album: '', invalid: msg }); };

    // Column counts must match exactly: a comma in an unquoted name shifts everything after
    // it, which can't be spotted any other way when the extra columns are empty.
    if (row.error) {
      bad(row.error);
      continue;
    }
    if (f.length > names.length) {
      bad(`has ${f.length} columns, but the header has ${names.length}. A name probably contains a comma without quotes around it. ` +
        `Put quotes around any name with a comma in it, e.g. nuclear winter,"hail, satan"`);
      continue;
    }
    if (f.length < names.length) {
      bad(`has only ${f.length} column${f.length === 1 ? '' : 's'}, but the header has ${names.length}. ` +
        'Every row needs the same columns as the header, in the same order.' +
        (row.raw.includes(' - ') ? ' It looks like "artist - album". Change the " - " to a comma.' : ''));
      continue;
    }

    const artist = cleanName(f[ai], 'artist', row.line, warn);
    const album = cleanName(f[bi], 'album', row.line, warn);
    if (!artist || !album) {
      bad(`the ${!artist && !album ? 'artist and album are' : !artist ? 'artist is' : 'album is'} blank.`);
      continue;
    }

    const key = `${norm(artist)}|${norm(album)}`;
    if (seen.has(key)) {
      warn(row.line, `"${artist} - ${album}" is a repeat of line ${seen.get(key)}. It will be skipped.`);
      continue;
    }
    seen.set(key, row.line);

    // Different names can end up with the same file name (e.g. "AC/DC" and "AC_DC", or a
    // difference only in capitals on a Mac), so later ones get a number added.
    const base = safeName(`${artist} - ${album}`) || `line ${row.line}`;
    let file = base;
    for (let n = 2; files.has(file.toLowerCase()); n++) file = `${base} (${n})`;
    if (file !== base && opts.download) {
      warn(row.line, `"${artist} - ${album}" would be saved with the same file name as line ${files.get(base.toLowerCase())}. It will be saved as "${file}.jpg".`);
    }
    files.set(file.toLowerCase(), row.line);

    albums.push({ line: row.line, artist, album, file: file + '.jpg' });
  }
  problems.sort((a, b) => a.line - b.line);
  return { albums, problems };
}

// Checks the results file can be written before spending time on searches.
function checkOutput(file) {
  const dir = path.dirname(path.resolve(file));
  if (!fs.existsSync(dir)) fail(`Can't write the results to "${file}" because the folder "${dir}" doesn't exist.`);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) fail(`--out "${file}" is a folder. Give a file name, e.g. --out results.csv`);
  try { fs.accessSync(dir, fs.constants.W_OK); }
  catch { fail(`Can't write the results to "${file}" because you don't have permission to write in "${dir}".`); }
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- matching ----------

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  if (x.includes(y) || y.includes(x)) return 1;
  return 0;
}

function fixUrl(u) {
  if (!u) return '';
  const i = u.lastIndexOf('https://');
  return i > 0 ? u.slice(i) : u;
}

function coverUrl(r) {
  if (r.art_id) return `https://f4.bcbits.com/img/a${String(r.art_id).padStart(10, '0')}_0.jpg`;
  if (r.img) {
    // Fallback: add the "a" prefix if it's missing and swap in the _0 size suffix.
    return fixUrl(r.img)
      .replace(/\/img\/(?!a)(\d+)_/, '/img/a$1_')
      .replace(/_\d+\.(jpg|png)$/i, '_0.$1');
  }
  return '';
}

// ---------- network ----------

async function search(artist, album) {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Accept: 'application/json' },
    body: JSON.stringify({ search_text: `${artist} ${album}`, search_filter: 'a', full_page: false, fan_id: null }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return JSON.parse(text); }
  catch { throw new Error('non-JSON response (likely a bot challenge)'); }
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buf);
  return buf;
}

// ---------- image dimensions ----------

function imageSize(buf) {
  // PNG: 8-byte signature, then IHDR with width/height at offsets 16/20
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segments until a SOFn marker
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

function safeName(s) {
  return s.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 200);
}

// ---------- main ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function processRow(artist, album) {
  const out = { artist, album, status: 'NO MATCH', matched_artist: '', matched_album: '', page_url: '', cover_url: '', width: '', height: '', note: '' };
  let data;
  try { data = await search(artist, album); }
  catch (e) { out.status = 'ERROR'; out.note = e.message; return out; }

  const results = ((data && data.auto && data.auto.results) || []).filter(r => r.type === 'a');
  let best = null, bestScore = -1;
  for (const r of results) {
    const score = similarity(album, r.name) + similarity(artist, r.band_name);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (!best || bestScore < 2) {
    out.note = results.length ? `best score ${bestScore}` : 'no album results';
    return out;
  }
  out.status = bestScore >= 4 ? 'MATCH' : 'CHECK';
  out.matched_artist = best.band_name || '';
  out.matched_album = best.name || '';
  out.page_url = fixUrl(best.item_url_path);
  out.cover_url = coverUrl(best);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { albums: all, problems } = loadAlbums(readInput(opts.csv), opts);

  // Report every problem in the file at once, before any searches.
  const errors = problems.filter(p => p.level === 'error');
  for (const p of problems) {
    console.log(`${p.level === 'error' ? 'Problem' : 'Warning'}, line ${p.line}: ${p.msg}`);
  }
  if (errors.length && !opts.skipBad) {
    fail(`Found ${errors.length} problem row${errors.length === 1 ? '' : 's'} in "${opts.csv}" (listed above). Nothing was searched.\n` +
      'Fix those lines and run again, or add --skip-bad-rows to search the other rows and list the problem rows as INVALID in the results.');
  }
  const albums = all.filter(a => !a.invalid);
  if (!albums.length) fail(`None of the rows in "${opts.csv}" are usable, so there's nothing to search.`);
  if (problems.length) console.log('');

  checkOutput(opts.out);
  if (opts.download) {
    try { fs.mkdirSync(opts.covers, { recursive: true }); }
    catch (e) { fail(`Can't create the covers folder "${opts.covers}": ${e.message}`); }
  }

  const results = all.filter(a => a.invalid).map(a => ({
    artist: a.artist, album: a.album, status: 'INVALID', matched_artist: '', matched_album: '',
    page_url: '', cover_url: '', width: '', height: '', note: `line ${a.line}`,
  }));
  for (let n = 0; n < albums.length; n++) {
    const { artist, album, file } = albums[n];
    if (n > 0) await sleep(opts.delay);
    const r = await processRow(artist, album);

    const wanted = r.status === 'MATCH' || (opts.includeCheck && r.status === 'CHECK');
    if (opts.download && wanted && r.cover_url) {
      try {
        const buf = await download(r.cover_url, path.join(opts.covers, file));
        const size = imageSize(buf);
        if (size) {
          r.width = size.width; r.height = size.height;
          if (Math.min(size.width, size.height) < MIN_SIZE) r.status = 'TOO SMALL';
        } else r.note = 'could not read image size';
      } catch (e) { r.note = `download failed: ${e.message}`; }
    }

    results.push(r);
    const dims = r.width ? ` ${r.width}x${r.height}` : '';
    const found = r.matched_album ? ` -> ${r.matched_artist} - ${r.matched_album}` : '';
    console.log(`[${n + 1}/${albums.length}] ${r.status.padEnd(9)} ${artist} - ${album}${found}${dims}${r.note ? ` (${r.note})` : ''}`);
  }

  const cols = ['artist', 'album', 'status', 'matched_artist', 'matched_album', 'page_url', 'cover_url', 'width', 'height'];
  const csv = [cols.join(','), ...results.map(r => cols.map(c => csvField(r[c])).join(','))].join('\n') + '\n';
  fs.writeFileSync(opts.out, csv);

  // Summary
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log('\nSummary:');
  for (const [s, c] of Object.entries(counts)) console.log(`  ${s.padEnd(9)} ${c}`);

  // Anything that isn't a MATCH at >= 1600px needs a manual look. Without --download
  // sizes are unknown, so only non-MATCH rows are listed.
  const ok = r => r.status === 'MATCH' && (!opts.download || (r.width && Math.min(r.width, r.height) >= MIN_SIZE));
  const todo = results.filter(r => !ok(r));
  if (!opts.download) console.log('\n(Sizes not checked, run with --download to verify 1600px+)');
  if (todo.length) {
    console.log(`\nNeeds manual lookup (${todo.length}):`);
    for (const r of todo) console.log(`  [${r.status}] ${r.album ? `${r.artist} - ${r.album}` : r.artist}`);
  }
  console.log(`\nWrote ${opts.out}`);
}

main().catch(e => {
  console.error(`\nError: ${e.message}`);
  if (!e.userError) console.error('(This looks like a bug in the script, not a problem with your file.)\n' + e.stack);
  process.exit(1);
});
