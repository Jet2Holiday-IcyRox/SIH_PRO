/**
 * Optional AI layer.
 *
 * Everything here is an enhancement over a deterministic result that already exists.
 * If no API key is configured, if the call fails, or if it takes too long, the caller
 * keeps the deterministic output and the kiosk behaves identically. That is deliberate:
 * a hospital kiosk must not stop working because an API is unreachable, and a demo must
 * not depend on conference wifi.
 *
 * What the model is allowed to do:
 *   - rewrite an already-generated summary into cleaner clinical prose
 *   - pull structured values out of OCR text from a lab report
 *
 * What it is never allowed to do:
 *   - invent a clinical question (the ontology is the whole question space)
 *   - assign a NAMASTE or ICD-11 code (only the official release does that)
 *   - state a diagnosis
 *
 * Provider is chosen from whichever key is present, Gemini first. Both speak the same
 * internal `complete()` interface so the callers below never branch on provider.
 */

const path = require('path');

// server.js already loads the root .env before requiring this module, and a hosted
// deploy has no file at all. This is only a fallback for the case where intake/ is
// required directly (a test, a script), and it reads the same single root .env.
try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
} catch (err) { /* dotenv is optional; real env vars still work */ }

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

let provider = null;
let resolved = false;

function getProvider() {
  if (resolved) return provider;
  resolved = true;

  if (process.env.GEMINI_API_KEY) {
    provider = { name: 'gemini', model: GEMINI_MODEL, complete: geminiComplete };
    console.log(`[LLM] Gemini enabled (${GEMINI_MODEL}). Deterministic output remains the fallback.`);
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = { name: 'anthropic', model: ANTHROPIC_MODEL, complete: anthropicComplete };
    console.log(`[LLM] Anthropic enabled (${ANTHROPIC_MODEL}). Deterministic output remains the fallback.`);
  } else {
    provider = null;
    console.log('[LLM] No API key set — running fully deterministic.');
  }
  return provider;
}

const isEnabled = () => Boolean(getProvider());

/** Races any provider call against a wall clock so a slow API cannot stall the kiosk. */
async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LLM timeout')), TIMEOUT_MS); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gemini via REST. No SDK dependency: this is two endpoints, and the ICD-11 client in
 * server.js already talks to its upstream the same way.
 */
async function geminiComplete({ system, user, json }) {
  const url = `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      ...(json ? { responseMimeType: 'application/json' } : {})
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const candidate = (data.candidates || [])[0];
  if (!candidate) throw new Error('Gemini returned no candidate');
  // A blocked or truncated response is a failure, not a result to hand to a clinician.
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new Error(`Gemini finishReason ${candidate.finishReason}`);
  }
  // Reasoning parts carry `thought: true` and must not be treated as the answer.
  return (candidate.content && candidate.content.parts || [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();
}

/** Anthropic path, kept so an ANTHROPIC_API_KEY alone still works. */
async function anthropicComplete({ system, user }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: user }]
  });
  if (response.stop_reason === 'refusal') throw new Error('refused');
  return (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

const SUMMARY_SYSTEM = `You are helping a physician in a busy Indian government hospital OPD read a patient history quickly.

You will be given a structured history captured from a patient by a self-service kiosk, plus a plain narrative already generated from it.

Rewrite the narrative as a tight clinical paragraph a doctor can read in ten seconds.

Rules you must follow:
- Use only facts present in the input. Never add a symptom, sign, duration or finding that is not there.
- Never state or imply a diagnosis, and never suggest treatment.
- Do not mention any diagnostic code.
- Use standard clinical register and abbreviations a physician expects.
- Write one paragraph, at most 70 words. Output the paragraph alone, with no preamble.`;

/**
 * Polishes the deterministic narrative. Returns the original on any failure, so callers
 * can use the result unconditionally.
 */
async function polishNarrative(summary) {
  const api = getProvider();
  if (!api) return { text: summary.narrative, source: 'deterministic' };

  const structured = Object.entries(summary.sections)
    .map(([section, entries]) => `${section.toUpperCase()}\n` + entries.map((e) => `- ${e.question} ${e.answer}`).join('\n'))
    .join('\n\n');

  try {
    const text = await withTimeout(api.complete({
      system: SUMMARY_SYSTEM,
      user: `Structured history:\n${structured}\n\nGenerated narrative:\n${summary.narrative}\n\nRewrite the narrative.`
    }));
    return text
      ? { text, source: 'ai-polished', model: api.model, provider: api.name }
      : { text: summary.narrative, source: 'deterministic' };
  } catch (err) {
    console.warn('[LLM] polishNarrative fell back:', err.message);
    return { text: summary.narrative, source: 'deterministic' };
  }
}

const LAB_SYSTEM = `You extract laboratory results from OCR text of Indian hospital lab reports.

The OCR is noisy: characters may be wrong, columns may be merged, and headers may repeat.

Return ONLY a JSON object of this shape:
{"reportDate":"YYYY-MM-DD or null","labName":"string or null","results":[{"analyte":"string","value":"string","unit":"string or null","referenceRange":"string or null","abnormal":true|false|null}]}

Rules:
- Include only rows where you can read both an analyte name and a value.
- Set "abnormal" true only when the value clearly falls outside a reference range printed in the text. If no range is printed, use null.
- Never invent a value, a unit, a range or a date.
- If nothing is readable, return {"reportDate":null,"labName":null,"results":[]}.`;

/**
 * Structures OCR text from a lab report. The kiosk shows whatever comes back for the
 * patient to confirm, so a partial extraction is useful and a failed one is harmless.
 */
async function extractLabValues(ocrText) {
  const api = getProvider();
  if (!api) return { results: [], source: 'unavailable' };
  const text = String(ocrText || '').trim();
  if (text.length < 20) return { results: [], source: 'too-short' };

  try {
    const raw = await withTimeout(api.complete({
      system: LAB_SYSTEM,
      user: `OCR text:\n\n${text.slice(0, 12000)}`,
      json: true
    }));
    // Always parse the response; never string-match it. Strip a code fence if the
    // model added one despite being asked for bare JSON.
    const parsed = JSON.parse(raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
    return {
      reportDate: parsed.reportDate || null,
      labName: parsed.labName || null,
      results: Array.isArray(parsed.results) ? parsed.results : [],
      source: 'ai-extracted',
      model: api.model,
      provider: api.name
    };
  } catch (err) {
    console.warn('[LLM] extractLabValues fell back:', err.message);
    return { results: [], source: 'failed', error: err.message };
  }
}

module.exports = { isEnabled, polishNarrative, extractLabValues };
