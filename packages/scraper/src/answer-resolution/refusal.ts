// Some pre-scraped answers in the DB are LLM refusal paragraphs ("I can't answer
// that on the candidate's behalf...") rather than real answers. Filling a form
// field with one is worse than leaving it blank, so every filler screens
// candidate values through here before using them.
//
// Pure predicate with no collaborators, so it stays a plain export rather than a
// service (same rule as getProfileAnswer/matchRule in form-pre-answerer).
const REFUSAL_MARKERS = [
  "i can't answer",
  'i cannot answer',
  "i don't wish to",
  'the candidate should',
  'candidate needs to',
  'candidate themselves',
  'i decline to',
  "i shouldn't guess",
  "i'm not able to",
  'i am not able to',
  'only the candidate',
  'inferred from',
  'not included in',
  'sensitive personal',
  'this is personal',
];

export function isRefusalText(v: string): boolean {
  if (!v) return true;
  const t = v.trim().toLowerCase();
  if (t.length > 400) return true;
  return REFUSAL_MARKERS.some((m) => t.includes(m));
}
