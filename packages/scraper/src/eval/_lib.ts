export interface Expect {
  equals?: string;
  includes?: string | string[];
  oneOf?: string[];
  notIncludes?: string[];
  regex?: string;
  minLength?: number;
  maxLength?: number;
}

export interface GradeResult {
  ok: boolean;
  reason?: string;
}

export function grade(actual: string, expected: Expect): GradeResult {
  const a = (actual ?? '').trim();
  if (expected.equals !== undefined && a !== expected.equals) {
    return { ok: false, reason: `equals mismatch: want "${expected.equals}", got "${a}"` };
  }
  if (expected.includes !== undefined) {
    const needles = Array.isArray(expected.includes) ? expected.includes : [expected.includes];
    for (const n of needles) {
      if (!a.includes(n))
        return { ok: false, reason: `missing substring "${n}" in "${a.slice(0, 80)}"` };
    }
  }
  if (expected.oneOf !== undefined && !expected.oneOf.includes(a)) {
    return { ok: false, reason: `not in oneOf ${JSON.stringify(expected.oneOf)}: got "${a}"` };
  }
  if (expected.notIncludes !== undefined) {
    for (const banned of expected.notIncludes) {
      if (a.toLowerCase().includes(banned.toLowerCase())) {
        return { ok: false, reason: `contains banned phrase "${banned}"` };
      }
    }
  }
  if (expected.regex !== undefined && !new RegExp(expected.regex).test(a)) {
    return { ok: false, reason: `regex /${expected.regex}/ did not match "${a.slice(0, 80)}"` };
  }
  if (expected.minLength !== undefined && a.length < expected.minLength) {
    return { ok: false, reason: `too short: ${a.length} < ${expected.minLength}` };
  }
  if (expected.maxLength !== undefined && a.length > expected.maxLength) {
    return { ok: false, reason: `too long: ${a.length} > ${expected.maxLength}` };
  }
  return { ok: true };
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function preview(s: string): string {
  const oneLine = (s ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `"${oneLine.slice(0, 57)}..."` : `"${oneLine}"`;
}

// ── Numeric range + array-of-string helpers for the scorer harness ──────────

export interface RangeExpect {
  min?: number;
  max?: number;
}

export function gradeRange(actual: number, expected: RangeExpect, label = 'value'): GradeResult {
  if (expected.min !== undefined && actual < expected.min) {
    return { ok: false, reason: `${label} ${actual} < min ${expected.min}` };
  }
  if (expected.max !== undefined && actual > expected.max) {
    return { ok: false, reason: `${label} ${actual} > max ${expected.max}` };
  }
  return { ok: true };
}

// All needles must appear somewhere in the array (case-insensitive substring).
export function gradeArrayIncludes(
  actual: string[],
  needles: string[],
  label: string,
): GradeResult {
  const lower = actual.map((s) => s.toLowerCase());
  for (const n of needles) {
    const found = lower.some((a) => a.includes(n.toLowerCase()));
    if (!found)
      return { ok: false, reason: `${label} missing "${n}": got ${JSON.stringify(actual)}` };
  }
  return { ok: true };
}

// None of the excludes should appear in the array.
export function gradeArrayExcludes(
  actual: string[],
  excludes: string[],
  label: string,
): GradeResult {
  const lower = actual.map((s) => s.toLowerCase());
  for (const e of excludes) {
    const found = lower.some((a) => a.includes(e.toLowerCase()));
    if (found) return { ok: false, reason: `${label} unexpectedly contains "${e}"` };
  }
  return { ok: true };
}
