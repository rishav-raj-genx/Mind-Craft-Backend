/**
 * intentParser.js — Vernacular Intent & Skill Extraction Engine
 *
 * Parses transcribed text (from Sarvam AI) to extract the subject or
 * skill the user is searching for. Uses fuzzy matching against the
 * predefined SKILLS_LIST to handle transliteration variations, regional
 * spellings, and code-mixed speech (e.g. "Hinglish").
 */

const { SKILLS_LIST } = require('../utils/constants');

/**
 * Hindi / regional keyword → English skill mapping.
 * Covers common transliterations and vernacular names.
 */
const VERNACULAR_MAP = {
  // Hindi / Hinglish
  'ganit':          'Mathematics',
  'math':           'Mathematics',
  'maths':          'Mathematics',
  'गणित':           'Mathematics',
  'bhautiki':       'Physics',
  'physics':        'Physics',
  'भौतिकी':         'Physics',
  'rasayan':        'Chemistry',
  'chemistry':      'Chemistry',
  'रसायन':          'Chemistry',
  'python':         'Python',
  'पाइथन':          'Python',
  'java':           'Java',
  'जावा':           'Java',
  'kotlin':         'Kotlin',
  'कोटलिन':         'Kotlin',
  'dsa':            'DSA',
  'data structure': 'DSA',
  'डीएसए':          'DSA',
  'machine learning': 'Machine Learning',
  'ml':             'Machine Learning',
  'एमएल':           'Machine Learning',
  'web development': 'Web Dev',
  'web dev':        'Web Dev',
  'वेब डेवलपमेंट':   'Web Dev',
  'react':          'React',
  'रिएक्ट':         'React',
  'sql':            'SQL',
  'एसक्यूएल':       'SQL',
  'database':       'SQL',
  'ui ux':          'UI/UX Design',
  'ui/ux':          'UI/UX Design',
  'design':         'UI/UX Design',
  'figma':          'Figma',
  'फिगमा':          'Figma',
  'english':        'English Communication',
  'angrezi':        'English Communication',
  'अंग्रेजी':       'English Communication',
  'public speaking': 'Public Speaking',
  'graphic design': 'Graphic Design',
  'video editing':  'Video Editing',
  'excel':          'Excel/Sheets',
  'sheets':         'Excel/Sheets',
  'cyber security': 'Cybersecurity',
  'cybersecurity':  'Cybersecurity',
  'cloud':          'Cloud Computing',
  'cloud computing': 'Cloud Computing',
  'arduino':        'Arduino/IoT',
  'iot':            'Arduino/IoT',
  'circuit':        'Circuit Design',
  'cad':            'CAD',
  'economics':      'Economics',
  'arthshastra':    'Economics',
  'अर्थशास्त्र':    'Economics',
  'accounting':     'Accounting',
  'lekha':          'Accounting',
};

/**
 * Extracts the intended skill from transcribed text.
 *
 * Strategy (in priority order):
 *   1. Direct VERNACULAR_MAP lookup (exact phrase match)
 *   2. SKILLS_LIST substring match (case-insensitive)
 *   3. Fuzzy token-level Levenshtein matching
 *
 * @param {string} transcript — Transcribed text from Sarvam AI
 * @returns {{ skill: string | null, confidence: number, method: string }}
 */
function extractSkillIntent(transcript) {
  if (!transcript || typeof transcript !== 'string') {
    return { skill: null, confidence: 0, method: 'none' };
  }

  const normalized = transcript.toLowerCase().trim();
  const tokens     = normalized.split(/[\s,;.!?]+/).filter(Boolean);

  // ── Pass 1: Vernacular map (exact phrase) ─────────────────────────
  for (const [phrase, skill] of Object.entries(VERNACULAR_MAP)) {
    if (normalized.includes(phrase.toLowerCase())) {
      return { skill, confidence: 0.95, method: 'vernacular_map' };
    }
  }

  // ── Pass 2: SKILLS_LIST substring match ───────────────────────────
  for (const skill of SKILLS_LIST) {
    if (normalized.includes(skill.toLowerCase())) {
      return { skill, confidence: 0.90, method: 'substring_match' };
    }
  }

  // ── Pass 3: Fuzzy Levenshtein on individual tokens ────────────────
  let bestMatch  = null;
  let bestDist   = Infinity;
  let bestTarget = '';

  const allTargets = [
    ...SKILLS_LIST.map((s) => s.toLowerCase()),
    ...Object.keys(VERNACULAR_MAP),
  ];

  for (const token of tokens) {
    if (token.length < 3) continue; // skip short words like "ka", "me"

    for (const target of allTargets) {
      const dist = levenshtein(token, target.toLowerCase());
      const maxLen = Math.max(token.length, target.length);
      const similarity = 1 - dist / maxLen;

      if (similarity > 0.65 && dist < bestDist) {
        bestDist   = dist;
        bestTarget = target;
        bestMatch  = VERNACULAR_MAP[target] || SKILLS_LIST.find(
          (s) => s.toLowerCase() === target,
        ) || target;
      }
    }
  }

  if (bestMatch) {
    const maxLen    = Math.max(bestTarget.length, bestTarget.length);
    const confidence = Math.max(0, 1 - bestDist / maxLen);
    return {
      skill:      bestMatch,
      confidence: parseFloat(confidence.toFixed(2)),
      method:     'fuzzy_levenshtein',
    };
  }

  return { skill: null, confidence: 0, method: 'no_match' };
}

/**
 * Levenshtein edit distance between two strings.
 * Used for fuzzy matching of transliterated skill names.
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,       // deletion
        dp[i][j - 1] + 1,       // insertion
        dp[i - 1][j - 1] + cost, // substitution
      );
    }
  }

  return dp[m][n];
}

module.exports = { extractSkillIntent };
