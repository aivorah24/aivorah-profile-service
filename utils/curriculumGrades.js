// IB programmes are grade-bound (PYP 1–5, MYP 6–10, DP 11–12); every other
// board spans all grades. Same rule and wording as the frontend's
// src/utils/curriculumGrades.ts.
const IB_RANGES = { 'IB PYP': [1, 5], 'IB MYP': [6, 10], 'IB DP': [11, 12] };

function ibKey(curriculum) {
  const c = String(curriculum || '').trim().toUpperCase().replace(/[_\s]+/g, ' ');
  if (/^IB ?PYP$/.test(c)) return 'IB PYP';
  if (/^IB ?MYP$/.test(c)) return 'IB MYP';
  if (/^IB ?DP$/.test(c)) return 'IB DP';
  return null;
}

function gradeNumber(grade) {
  const m = String(grade || '').match(/(\d{1,2})/);
  return m ? parseInt(m[1], 10) : null;
}

function ibProgrammeForGrade(grade) {
  const n = gradeNumber(grade);
  if (n === null) return null;
  return Object.keys(IB_RANGES).find((k) => n >= IB_RANGES[k][0] && n <= IB_RANGES[k][1]) || null;
}

function curriculumGradeError(curriculum, grade) {
  const key = ibKey(curriculum);
  if (!key || !grade) return null;
  const [from, to] = IB_RANGES[key];
  const n = gradeNumber(grade);
  if (n !== null && n >= from && n <= to) return null;
  const choose = to - from === 1 ? `Grade ${from} or ${to}` : `a grade from ${from} to ${to}`;
  const other = ibProgrammeForGrade(grade);
  const switchTo = other && other !== key ? `, or switch to ${other} for ${grade}` : '';
  return `${key} is only for Grade ${from}–${to}. Please choose ${choose}${switchTo}.`;
}

module.exports = { curriculumGradeError, ibProgrammeForGrade, gradeNumber };
