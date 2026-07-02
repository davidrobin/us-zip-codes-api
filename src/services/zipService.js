const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

const SOURCE_PAGE = 'https://postalpro.usps.com/ZIP_Locale_Detail';

// USPS state/territory abbreviations mapped to full names. Used both to
// sanity-check the "state" column we auto-detect and to enrich responses
// with human-readable names.
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia', PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
  GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
};

const VALID_STATE_CODES = new Set(Object.keys(STATE_NAMES));

// In-memory cache so we don't hammer USPS on every request.
let cache = {
  byState: null,        // { CA: ['90001', ...], ... }
  states: null,         // ['AL', 'AK', ...] sorted
  totalZips: 0,
  sourceFileUrl: null,
  dataVintage: null,     // { year, month, monthName, label } parsed from the file's dated path
  fetchedAt: null,
};

const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function isCacheStale() {
  if (!cache.fetchedAt) return true;
  return Date.now() - cache.fetchedAt > CACHE_TTL_MS;
}

/**
 * Scrape the PostalPro page and return the absolute URL of the .xls download.
 * The file lives under a dated path (e.g. /mnt/glusterfs/2026-05/...) that
 * changes whenever USPS republishes it, so we never hardcode it.
 */
async function findXlsDownloadUrl() {
  const { data: html } = await axios.get(SOURCE_PAGE, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; usps-zip-api/1.0)' },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  let hrefFound = null;
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.toLowerCase().endsWith('.xls') || href.toLowerCase().endsWith('.xlsx')) {
      hrefFound = href;
      return false; // break out of .each
    }
  });

  if (!hrefFound) {
    throw new Error('Could not find a .xls/.xlsx download link on the source page');
  }

  return new URL(hrefFound, SOURCE_PAGE).toString();
}

/**
 * USPS publishes the file under a dated path, e.g.
 * https://postalpro.usps.com/mnt/glusterfs/2026-05/ZIP_Locale_Detail.xls
 * Extract that YYYY-MM so callers can tell how current the data is.
 */
function extractDataVintage(fileUrl) {
  const match = fileUrl.match(/(\d{4})-(\d{2})/);
  if (!match) return null;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) return null;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  return {
    year,
    month,
    monthName: monthNames[month - 1],
    label: `${monthNames[month - 1]} ${year}`,
  };
}

/**
 * Download the workbook as a binary buffer.
 */
async function downloadWorkbook(fileUrl) {
  const response = await axios.get(fileUrl, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; usps-zip-api/1.0)' },
    timeout: 30000,
  });
  return Buffer.from(response.data);
}

/**
 * Content-sniffing fallback: score every column by how well it looks like
 * a ZIP or state column, using BOTH the match ratio and the cardinality
 * (number of distinct values). This matters because low-cardinality
 * numeric codes (e.g. a 3-digit district number, zero-padded) can also
 * pass a naive "looks like 5 digits" check -- a real ZIP column will have
 * thousands of distinct values, a district code will have a few dozen.
 */
function contentSniffColumns(rows, sampleRows) {
  const columnCount = rows[0] ? rows[0].length : 0;
  let bestZip = { col: -1, score: -1 };
  let bestState = { col: -1, score: -1 };

  for (let col = 0; col < columnCount; col++) {
    let zipMatches = 0;
    let stateMatches = 0;
    let nonEmpty = 0;
    const distinctValues = new Set();

    for (const row of sampleRows) {
      const raw = row[col];
      if (raw === undefined || raw === null || raw === '') continue;
      nonEmpty++;

      const value = String(raw).trim();
      distinctValues.add(value);

      const zipCandidate = /^\d{1,5}$/.test(value) ? value.padStart(5, '0') : value;
      if (/^\d{5}$/.test(zipCandidate)) zipMatches++;

      if (/^[A-Za-z]{2}$/.test(value) && VALID_STATE_CODES.has(value.toUpperCase())) {
        stateMatches++;
      }
    }

    if (nonEmpty === 0) continue;

    const zipRatio = zipMatches / nonEmpty;
    const stateRatio = stateMatches / nonEmpty;

    // Score = match ratio * cardinality, so a true ZIP column (thousands of
    // distinct values) beats a low-cardinality numeric code column even if
    // both pass the "looks like 5 digits" check.
    if (zipRatio > 0.9) {
      const score = zipRatio * distinctValues.size;
      if (score > bestZip.score) bestZip = { col, score };
    }
    if (stateRatio > 0.9) {
      const score = stateRatio * distinctValues.size;
      if (score > bestState.score) bestState = { col, score };
    }
  }

  return { zipCol: bestZip.col, stateCol: bestState.col };
}

/**
 * Given the raw rows (array of arrays) from the sheet, figure out which
 * column holds ZIP codes and which holds the 2-letter state code.
 *
 * Strategy: prefer matching on header names first (USPS's real files use
 * clear headers like "DELIVERY ZIPCODE" / "ZIP CODE" and "PHYSICAL STATE" /
 * "STATE"), since that's unambiguous. Only fall back to content-sniffing
 * when no header match is found, e.g. if USPS ships a file with no header
 * row or unrecognized labels.
 */
function detectColumns(rows) {
  const headers = (rows[0] || []).map((h) => String(h || '').trim());
  const sampleRows = rows.slice(1, Math.min(rows.length, 500));

  // Ordered most-specific-first; first pattern with a match wins.
  const zipHeaderPatterns = [
    /^delivery\s*zip\s*code$/i,
    /^zip\s*code$/i,
    /^zipcode$/i,
    // generic "zip" match, but exclude ZIP+4 / physical-facility ZIP columns
    (h) => /zip/i.test(h) && !/4|physical/i.test(h),
  ];

  const stateHeaderPatterns = [
    /^physical\s*state$/i,
    /^state$/i,
    (h) => /state/i.test(h),
  ];

  function findHeaderColumn(patterns) {
    for (const pattern of patterns) {
      const idx = headers.findIndex((h) =>
        typeof pattern === 'function' ? pattern(h) : pattern.test(h)
      );
      if (idx !== -1) return idx;
    }
    return -1;
  }

  let zipCol = findHeaderColumn(zipHeaderPatterns);
  let stateCol = findHeaderColumn(stateHeaderPatterns);

  // Validate header-based picks actually contain zip/state-shaped data
  // (cheap sanity check in case a header is misleading), falling back to
  // content-sniffing for whichever one fails.
  if (zipCol !== -1) {
    const sample = sampleRows.slice(0, 50).map((r) => String(r[zipCol] ?? '').trim());
    const validRatio = sample.filter((v) => /^\d{1,5}$/.test(v)).length / Math.max(sample.length, 1);
    if (validRatio < 0.5) zipCol = -1;
  }
  if (stateCol !== -1) {
    const sample = sampleRows.slice(0, 50).map((r) => String(r[stateCol] ?? '').trim().toUpperCase());
    const validRatio = sample.filter((v) => VALID_STATE_CODES.has(v)).length / Math.max(sample.length, 1);
    if (validRatio < 0.5) stateCol = -1;
  }

  if (zipCol === -1 || stateCol === -1) {
    const sniffed = contentSniffColumns(rows, sampleRows);
    if (zipCol === -1) zipCol = sniffed.zipCol;
    if (stateCol === -1) stateCol = sniffed.stateCol;
  }

  return { zipCol, stateCol };
}

/**
 * Parse the workbook buffer into { byState, states, totalZips }.
 */
function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  // USPS's real file ships 3 sheets: the full per-record detail list,
  // a smaller "unique" subset, and a residual "Other" sheet. We want the
  // full detail sheet. Prefer it by name if present, otherwise fall back
  // to the first sheet (older/renamed file revisions).
  const preferredSheetName = workbook.SheetNames.find(
    (name) => /^zip[_\s]?detail$/i.test(name.trim())
  );
  const sheetName = preferredSheetName || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // header: 1 -> array-of-arrays, easiest for column sniffing
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  if (!rows.length) {
    throw new Error('The downloaded spreadsheet has no rows');
  }

  const { zipCol, stateCol } = detectColumns(rows);

  if (zipCol === -1 || stateCol === -1) {
    throw new Error(
      `Could not auto-detect ZIP/state columns in the spreadsheet (zipCol=${zipCol}, stateCol=${stateCol}). ` +
      'USPS may have changed the file layout.'
    );
  }

  const byState = {};
  let totalZips = 0;

  // Skip header row
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawZip = row[zipCol];
    const rawState = row[stateCol];
    if (rawZip === '' || rawState === '') continue;

    const zip = String(rawZip).trim().padStart(5, '0');
    const state = String(rawState).trim().toUpperCase();

    if (!/^\d{5}$/.test(zip) || !VALID_STATE_CODES.has(state)) continue;

    if (!byState[state]) byState[state] = new Set();
    byState[state].add(zip);
  }

  const result = {};
  for (const [state, zipSet] of Object.entries(byState)) {
    result[state] = Array.from(zipSet).sort();
    totalZips += result[state].length;
  }

  return {
    byState: result,
    states: Object.keys(result).sort(),
    totalZips,
    debug: {
      sheetUsed: sheetName,
      availableSheets: workbook.SheetNames,
      zipColumnHeader: rows[0][zipCol],
      stateColumnHeader: rows[0][stateCol],
      totalRowsInSheet: rows.length - 1,
    },
  };
}

/**
 * Refresh the in-memory cache by re-scraping and re-downloading the file.
 */
async function refresh() {
  const fileUrl = await findXlsDownloadUrl();
  const buffer = await downloadWorkbook(fileUrl);
  const { byState, states, totalZips, debug } = parseWorkbook(buffer);

  cache = {
    byState,
    states,
    totalZips,
    sourceFileUrl: fileUrl,
    dataVintage: extractDataVintage(fileUrl),
    fetchedAt: Date.now(),
    debug,
  };

  return cache;
}

/**
 * Ensure the cache is populated (and not stale), refreshing if needed.
 */
async function ensureFresh() {
  if (!cache.byState || isCacheStale()) {
    await refresh();
  }
  return cache;
}

function getCacheMeta() {
  return {
    sourceFileUrl: cache.sourceFileUrl,
    dataVintage: cache.dataVintage || null,
    fetchedAt: cache.fetchedAt,
    totalStates: cache.states ? cache.states.length : 0,
    totalZips: cache.totalZips,
    debug: cache.debug || null,
  };
}

function getAllByState() {
  return cache.byState || {};
}

function getStates() {
  return (cache.states || []).map((code) => ({
    code,
    name: STATE_NAMES[code] || code,
  }));
}

function getZipsForState(stateCode) {
  const byState = cache.byState || {};
  return byState[stateCode.toUpperCase()] || null;
}

function getStateName(stateCode) {
  return STATE_NAMES[stateCode.toUpperCase()] || null;
}

module.exports = {
  refresh,
  ensureFresh,
  getCacheMeta,
  getAllByState,
  getStates,
  getZipsForState,
  getStateName,
  // exported mainly for testing/inspection
  parseWorkbook,
  detectColumns,
  extractDataVintage,
  STATE_NAMES,
};

