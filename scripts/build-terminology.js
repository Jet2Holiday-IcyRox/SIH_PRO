/**
 * Builds data/namaste_terminology.json from the official Ministry of Ayush
 * release "NATIONAL AYURVEDA MORBIDITY CODES.xls".
 *
 * The release encodes its own NAMASTE -> ICD-11 TM2 crosswalk inside NAMC_CODE:
 * a row coded "SP12 (AAE-16)" carries the WHO TM2 code SP12 and the NAMASTE code
 * AAE-16, while a row coded "AAD-1.12" is NAMASTE-only and has no TM2 equivalent.
 * Only 373 of the 2910 concepts are officially mapped; the rest are emitted with
 * mappingStatus 'unmapped' so $translate routes them to the curation queue rather
 * than guessing a code.
 *
 * TM2 titles/entity ids are read from the licensed WHO ICD-11 container so no
 * display text is invented here.
 *
 *   node scripts/build-terminology.js [path/to/namaste.csv]
 *
 * The .xls is converted to CSV first (LibreOffice ships on most machines):
 *   soffice --headless --convert-to csv "NATIONAL AYURVEDA MORBIDITY CODES.xls"
 */

const fs = require('fs');
const path = require('path');

const ICD_HOST = process.env.ICD11_HOST || 'http://localhost';
const ICD_RELEASE = process.env.ICD11_RELEASE || '2026-01';
const OUT = path.join(__dirname, '..', 'data', 'namaste_terminology.json');

// NAMC_CODE holds both codes when a row is TM2-mapped. Spacing is inconsistent in
// the release ("SR13(AAA-3)", "SR10  (AAA-2.1)"), so tolerate any amount of it.
// ICD-11 stem codes are two letters, a digit, then a digit OR letter (SR11, SM8D,
// SP9Y residuals), with an optional .N subdivision. Matching only [A-Z]{2}\d{2} here
// silently drops every residual-category mapping in the release.
const TM2_CODE = '[A-Z]{2}\\d[0-9A-Z](?:\\.[0-9A-Z]+)?';
const TM2_PAIR = new RegExp(`^(${TM2_CODE})\\s*\\(([^)]+)\\)$`);
const NAMASTE_PAIR = new RegExp(`^([A-Z]{2,4}-[\\d.]+)\\s*\\((${TM2_CODE})\\)$`);

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// The release uses '-' as its null marker in every optional column.
const clean = (v) => {
  const s = String(v || '').trim();
  return !s || s === '-' ? '' : s;
};

// "SP12 (AAE-16)" -> { tm2: 'SP12', namaste: 'AAE-16' }
// "EA-4.5.1(SL40)" -> same pair with the operands the other way round
// "AAD-1.12"       -> NAMASTE only
function splitCodes(raw) {
  const code = String(raw || '').replace(/\s+/g, ' ').trim();
  let m = code.match(TM2_PAIR);
  if (m) return { tm2: m[1], namaste: m[2].trim() };
  m = code.match(NAMASTE_PAIR);
  if (m) return { tm2: m[2], namaste: m[1].trim() };
  return { tm2: '', namaste: code };
}

async function lookupTm2(code) {
  const headers = { accept: 'application/json', 'API-Version': 'v2', 'Accept-Language': 'en' };
  try {
    const infoRes = await fetch(`${ICD_HOST}/icd/release/11/${ICD_RELEASE}/mms/codeinfo/${encodeURIComponent(code)}`, { headers });
    if (!infoRes.ok) return null;
    const info = await infoRes.json();
    if (!info.stemId) return null;
    const entityRes = await fetch(info.stemId.replace('http://id.who.int', ICD_HOST), { headers });
    if (!entityRes.ok) return null;
    const entity = await entityRes.json();
    return {
      title: entity.title && entity.title['@value'] ? entity.title['@value'] : '',
      definition: entity.definition && entity.definition['@value'] ? entity.definition['@value'] : '',
      entityId: String(info.stemId).split('/').pop(),
      entityUri: info.stemId
    };
  } catch {
    return null;
  }
}

async function main() {
  const csvPath = process.argv[2] || path.join(__dirname, '..', 'namaste.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`[namaste] CSV not found: ${csvPath}`);
    console.error('[namaste] Convert the release first:');
    console.error('[namaste]   soffice --headless --convert-to csv "NATIONAL AYURVEDA MORBIDITY CODES.xls"');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);
  const idx = {
    namcId: col('NAMC_ID'),
    code: col('NAMC_CODE'),
    term: col('NAMC_term'),
    diacritical: col('NAMC_term_diacritical'),
    devanagari: col('NAMC_term_DEVANAGARI'),
    shortDef: col('Short_definition'),
    longDef: col('Long_definition'),
    branches: col('Ontology_branches'),
    english: col('Name English'),
    index: col('Name English Under Index')
  };
  if (idx.code < 0 || idx.term < 0) throw new Error('Unexpected columns — is this the NAMASTE release?');

  const seen = new Set();
  const concepts = [];
  for (const row of rows.slice(1)) {
    if (row.length < header.length - 2) continue;
    const { tm2, namaste } = splitCodes(row[idx.code]);
    if (!namaste) continue;
    // The release repeats a handful of rows (e.g. SR10 twice with different spacing).
    const key = `${namaste}|${tm2}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // "Osteoarthritis disorder (TM2)" -> "Osteoarthritis disorder"; the suffix is a
    // provenance marker in the release, not part of the clinical display name.
    const englishRaw = clean(row[idx.english]);
    const english = englishRaw.replace(/\s*\(TM2\)\s*⇒?\s*$/, '').trim();

    concepts.push({
      id: `NAMC-${clean(row[idx.namcId]) || concepts.length + 1}`,
      namasteCode: namaste,
      icd11Tm2Code: tm2 || null,
      term: clean(row[idx.diacritical]) || clean(row[idx.term]),
      termTransliteration: clean(row[idx.term]),
      termSanskrit: clean(row[idx.devanagari]),
      termEnglish: english || clean(row[idx.term]),
      definition: clean(row[idx.longDef]) || clean(row[idx.shortDef]),
      ontologyBranch: clean(row[idx.branches]),
      system: 'ayurveda',
      ayushStream: 'Ayurveda',
      mappingStatus: tm2 ? 'official-tm2' : 'unmapped',
      // Equivalence and confidence are properties of the official release, not of a
      // similarity score we invented: a published pair is asserted equivalent, an
      // absent one is simply unmapped.
      relationship: tm2 ? 'equivalent' : 'unmatched',
      confidence: tm2 ? 100 : null,
      synonyms: [clean(row[idx.index]), clean(row[idx.term])].filter(Boolean)
    });
  }

  const mapped = concepts.filter((c) => c.icd11Tm2Code);
  console.log(`[namaste] parsed ${concepts.length} concepts (${mapped.length} officially TM2-mapped)`);

  // Enrich only the mapped rows; unmapped ones have nothing to look up.
  const uniqueCodes = [...new Set(mapped.map((c) => c.icd11Tm2Code))];
  const titles = new Map();
  let resolved = 0;
  for (const code of uniqueCodes) {
    const info = await lookupTm2(code);
    if (info) { titles.set(code, info); resolved++; }
  }
  console.log(`[namaste] resolved ${resolved}/${uniqueCodes.length} TM2 codes against the WHO container`);

  for (const c of concepts) {
    const info = c.icd11Tm2Code ? titles.get(c.icd11Tm2Code) : null;
    c.icd11Tm2Title = info ? info.title : null;
    c.icd11EntityId = info ? info.entityId : null;
    c.icd11EntityUri = info ? info.entityUri : null;
    if (info && info.definition && !c.definition) c.definition = info.definition;
  }

  const payload = {
    meta: {
      source: 'NATIONAL AYURVEDA MORBIDITY CODES.xls (Ministry of Ayush)',
      namasteRelease: 'NAMASTE Ayurveda (National Ayurveda Morbidity Codes)',
      icd11Release: `ICD-11 ${ICD_RELEASE} MMS`,
      tm2Chapter: 'Chapter 26 — Supplementary Chapter Traditional Medicine Conditions',
      generatedAt: new Date().toISOString(),
      totalConcepts: concepts.length,
      officiallyMapped: mapped.length,
      unmapped: concepts.length - mapped.length,
      tm2TitlesResolved: resolved
    },
    concepts
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`[namaste] wrote ${OUT}`);
}

main().catch((err) => { console.error('[namaste] failed:', err); process.exit(1); });
