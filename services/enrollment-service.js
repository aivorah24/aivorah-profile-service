const supabase = require('./supabase');
const { readPreferences } = require('./preferences');
const { normalizeCurriculum, curriculumAliases } = require('../utils/curriculum');

// ── Auto-link teacher ↔ students by curriculum + grade ────────────────
// Matches on both curriculum AND grade so a Grade-3 student is only linked
// to teachers whose teaches[] includes Grade 3, not every teacher in the curriculum.

async function syncStudentEnrollment({ userId, curriculum, grade }) {
  const { data: allTeachers } = await supabase
    .from('users')
    .select('id, email')
    .eq('role', 'teacher')
    .in('curriculum', curriculumAliases(curriculum));

  const allPrefs = (allTeachers && allTeachers.length > 0) ? await readPreferences() : {};
  const matchingTeachers = (allTeachers ?? []).filter(t => {
    const tp = allPrefs[t.email] ?? {};
    if (Array.isArray(tp.teaches) && tp.teaches.length > 0) {
      return tp.teaches.some(tg => normalizeCurriculum(tg.curriculum) === normalizeCurriculum(curriculum) && tg.grade === grade);
    }
    return false;
  });

  if (matchingTeachers.length === 0) return;

  const ids = matchingTeachers.map(t => t.id);
  await supabase.from('teacher_student')
    .delete()
    .eq('student_id', userId)
    .not('teacher_id', 'in', `(${ids.join(',')})`);
  const rows = ids.map(tid => ({ teacher_id: tid, student_id: userId, subject: curriculum }));
  await supabase.from('teacher_student').upsert(rows, { onConflict: 'teacher_id,student_id', ignoreDuplicates: true });
}

async function syncTeacherEnrollment({ userId, curriculum, grade, teaches }) {
  const teacherGrades = Array.isArray(teaches) && teaches.length > 0
    ? teaches
    : [{ grade, curriculum }];

  const { data: allStudents } = await supabase
    .from('users')
    .select('id, grade, curriculum')
    .eq('role', 'student');

  const matchingStudents = (allStudents ?? []).filter(s =>
    s.curriculum && s.grade &&
    teacherGrades.some(tg => normalizeCurriculum(tg.curriculum) === normalizeCurriculum(s.curriculum) && tg.grade === s.grade)
  );

  if (matchingStudents.length === 0) return;

  const ids = matchingStudents.map(s => s.id);
  await supabase.from('teacher_student')
    .delete()
    .eq('teacher_id', userId)
    .not('student_id', 'in', `(${ids.join(',')})`);
  const rows = ids.map(sid => ({ teacher_id: userId, student_id: sid, subject: curriculum }));
  await supabase.from('teacher_student').upsert(rows, { onConflict: 'teacher_id,student_id', ignoreDuplicates: true });
}

// Called after a profile update — routes by role, non-blocking on failure
// (enrollment sync should never fail the profile save itself).
async function syncEnrollmentAfterProfileUpdate({ role, userId, curriculum, grade, teaches }) {
  if (!userId || !curriculum || !grade) return;
  try {
    if (role === 'student') {
      await syncStudentEnrollment({ userId, curriculum, grade });
    } else if (role === 'teacher') {
      await syncTeacherEnrollment({ userId, curriculum, grade, teaches });
    }
  } catch (err) {
    console.error('[enrollment-service] sync failed:', err?.message);
  }
}

module.exports = { syncEnrollmentAfterProfileUpdate, syncStudentEnrollment, syncTeacherEnrollment };
