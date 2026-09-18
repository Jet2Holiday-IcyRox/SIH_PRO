/**
 * The intake dialogue engine.
 *
 * Deterministic by construction: given a session's answers, `nextQuestion` returns
 * the same next step every time. No model is consulted to decide what to ask — the
 * question graph in ontology.js is the whole decision space. That is what makes the
 * interview auditable and what lets the kiosk run with the network down.
 */

const {
  CHIEF_COMPLAINTS, FLOWS, COMMON, AYUSH, PRAKRITI, RED_FLAGS
} = require('./ontology');

const CHIEF_COMPLAINT_QUESTION = {
  id: 'chief_complaint',
  section: 'complaint',
  type: 'single',
  prompt: { en: 'What brings you to the hospital today?', hi: 'आज आप अस्पताल क्यों आए हैं?' },
  help: { en: 'Tap a picture, or just say it out loud.', hi: 'तस्वीर दबाइए, या बोलकर बताइए।' },
  options: CHIEF_COMPLAINTS.map((c) => ({ value: c.id, label: c.label, icon: c.icon }))
};

function complaintById(id) {
  return CHIEF_COMPLAINTS.find((c) => c.id === id) || null;
}

/** Answers are stored as { [questionId]: value } where multi answers are arrays. */
function answerValues(answer) {
  if (answer === undefined || answer === null) return [];
  return Array.isArray(answer) ? answer : [answer];
}

function guardPasses(question, answers) {
  if (!question.when) return true;
  const { q, in: allowed } = question.when;
  const values = answerValues(answers[q]);
  return values.some((v) => allowed.includes(v));
}

/**
 * The full ordered question list for a session. Built fresh from the answers each
 * time so that changing the chief complaint re-plans the rest of the interview.
 */
function plan(answers, options = {}) {
  const questions = [CHIEF_COMPLAINT_QUESTION];
  const complaint = complaintById(answers.chief_complaint);
  if (!complaint) return questions;

  const flow = FLOWS[complaint.branch] || FLOWS.general;
  questions.push(...flow);
  questions.push(...COMMON);
  // AYUSH mode is a per-session switch: an Ayurvedic OPD turns it on, an allopathic
  // one does not, and the same kiosk serves both.
  if (options.ayushMode) questions.push(...PRAKRITI, ...AYUSH);
  return questions.filter((q) => guardPasses(q, answers));
}

/** Returns the next unanswered question, or null when the interview is complete. */
function nextQuestion(answers, options = {}) {
  const questions = plan(answers, options);
  const next = questions.find((q) => answers[q.id] === undefined);
  const answered = questions.filter((q) => answers[q.id] !== undefined).length;
  return {
    question: next || null,
    progress: { answered, total: questions.length, done: !next }
  };
}

/**
 * Flags are the bridge between answers and triage. Each selected option may carry
 * flags; scale questions raise theirs past a threshold. Collecting them separately
 * from the answers keeps the red-flag rules readable.
 */
function collectFlags(answers, options = {}) {
  const flags = new Set();
  for (const question of plan(answers, options)) {
    const answer = answers[question.id];
    if (answer === undefined) continue;

    if (question.type === 'scale') {
      if (question.severeFlag && Number(answer) >= question.severeAt) flags.add(question.severeFlag);
      continue;
    }
    for (const value of answerValues(answer)) {
      const option = (question.options || []).find((o) => o.value === value);
      for (const flag of (option && option.flags) || []) flags.add(flag);
    }
  }
  return flags;
}

/** Evaluates every red-flag rule; returns matches sorted most urgent first. */
function evaluateRedFlags(answers, options = {}) {
  const flags = collectFlags(answers, options);
  const complaint = answers.chief_complaint;
  const rank = { CRITICAL: 0, URGENT: 1, REVIEW: 2 };

  return RED_FLAGS
    .filter((rule) => {
      if (rule.complaint && !rule.complaint.includes(complaint)) return false;
      if (rule.all && !rule.all.every((f) => flags.has(f))) return false;
      if (rule.any && !rule.any.some((f) => flags.has(f))) return false;
      return Boolean(rule.all || rule.any);
    })
    .map((rule) => ({
      id: rule.id, priority: rule.priority, concern: rule.concern, action: rule.action,
      // Naming the evidence matters: triage staff need to see why the kiosk escalated,
      // not just that it did.
      matched: [...new Set([...(rule.all || []), ...(rule.any || [])])].filter((f) => flags.has(f))
    }))
    .sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Tallies Prakriti votes into a provisional constitutional profile. */
function scorePrakriti(answers) {
  const tally = { vata: 0, pitta: 0, kapha: 0 };
  let voted = 0;
  for (const question of [...PRAKRITI, ...AYUSH]) {
    for (const value of answerValues(answers[question.id])) {
      const option = (question.options || []).find((o) => o.value === value);
      if (option && tally[option.dosha] !== undefined) { tally[option.dosha]++; voted++; }
    }
  }
  if (!voted) return null;

  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const [topName, topScore] = ranked[0];
  const [secondName, secondScore] = ranked[1];
  // A near-tie is a dual-dosha constitution (dvandvaja), which is the common case —
  // forcing a single answer would misrepresent the assessment.
  const dominant = topScore - secondScore <= 1 && secondScore > 0
    ? `${topName}-${secondName}`
    : topName;

  return {
    tally,
    dominant,
    label: dominant.split('-').map((d) => d[0].toUpperCase() + d.slice(1)).join('-'),
    basis: `${voted} responses`,
    provisional: true
  };
}

/**
 * Renders the answers into the standard history sections. This is the physician-facing
 * artefact, so it is plain clinical English regardless of the language the patient used.
 */
function buildSummary(answers, options = {}) {
  const complaint = complaintById(answers.chief_complaint);
  const questions = plan(answers, options);
  const sections = {};

  const labelFor = (question, value) => {
    const option = (question.options || []).find((o) => o.value === value);
    return option ? option.label.en : String(value);
  };

  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined || answer === null || answer === '') continue;

    const values = answerValues(answer);
    if (values.length === 1 && (values[0] === 'none' || values[0] === 'no_cough' || values[0] === 'not_breathless')) continue;

    const text = question.type === 'scale'
      ? `${answer}/10`
      : question.type === 'text'
        ? String(answer)
        : values.map((v) => labelFor(question, v)).join(', ');

    const bucket = sections[question.section] || (sections[question.section] = []);
    bucket.push({
      id: question.id,
      pariksha: question.pariksha || null,
      question: question.prompt.en,
      answer: text
    });
  }

  const redFlags = evaluateRedFlags(answers, options);
  const prakriti = options.ayushMode ? scorePrakriti(answers) : null;

  return {
    chiefComplaint: complaint ? complaint.label.en : 'Not recorded',
    chiefComplaintId: complaint ? complaint.id : null,
    sections,
    redFlags,
    prakriti,
    priority: redFlags.length ? redFlags[0].priority : 'ROUTINE',
    narrative: narrate(complaint, sections),
    ayushMode: Boolean(options.ayushMode)
  };
}

/**
 * A one-paragraph HPI in the register a clinician expects. Deterministic: the LLM
 * layer may rewrite this for readability, but this version is what gets stored if
 * no key is configured, and it is always the fallback.
 */
function narrate(complaint, sections) {
  if (!complaint) return '';
  const hpi = sections.hpi || [];
  const value = (id) => {
    const entry = hpi.find((e) => e.id === id);
    return entry ? entry.answer.toLowerCase() : null;
  };

  const parts = [`Patient presents with ${complaint.label.en.toLowerCase()}`];
  const duration = value('duration');
  // The duration options read as answers ("Today", "A few days"), not as clauses,
  // so they need turning into one before they can be concatenated.
  const DURATION_CLAUSE = {
    today: ' since today',
    'a few days': ' for a few days',
    'a few weeks': ' for a few weeks',
    'months or longer': ' for several months'
  };
  if (duration) parts.push(DURATION_CLAUSE[duration] || ` for ${duration}`);

  const onset = value('onset');
  if (onset) parts.push(`, ${onset.replace('suddenly', 'of sudden onset').replace('slowly, over time', 'of gradual onset')}`);

  const character = value('character');
  if (character) parts.push(`, described as ${character}`);

  const radiation = value('radiation');
  if (radiation && !radiation.includes('stays in one place')) parts.push(`, radiating ${radiation}`);

  const severity = value('severity');
  if (severity) parts.push(`, severity ${severity}`);

  let sentence = parts.join('').replace(/\s+,/g, ',') + '.';

  const aggravating = value('aggravating');
  if (aggravating && !aggravating.includes('nothing in particular')) {
    sentence += ` Aggravated by ${aggravating}.`;
  }
  const associated = value('associated') || value('resp_associated') || value('fever_associated')
    || value('digestive_symptoms') || value('skin_character') || value('general_associated');
  if (associated) sentence += ` Associated with ${associated}.`;

  const detail = value('complaint_detail');
  if (detail) sentence += ` Patient's own words: "${detail}"`;

  return sentence;
}

module.exports = {
  CHIEF_COMPLAINT_QUESTION,
  complaintById,
  plan,
  nextQuestion,
  collectFlags,
  evaluateRedFlags,
  scorePrakriti,
  buildSummary
};
