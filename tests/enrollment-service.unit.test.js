// Unit tests for services/enrollment-service.js — auto-linking teachers and
// students by curriculum + grade after a profile update.

jest.mock('../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    __queue: [],
    then(resolve) {
      const next = chain.__queue.length ? chain.__queue.shift() : { data: undefined, error: null };
      return Promise.resolve(next).then(resolve);
    },
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

jest.mock('../services/preferences', () => ({ readPreferences: jest.fn() }));

const supabase = require('../services/supabase');
const { readPreferences } = require('../services/preferences');
const {
  syncEnrollmentAfterProfileUpdate, syncStudentEnrollment, syncTeacherEnrollment,
} = require('../services/enrollment-service');

beforeEach(() => {
  jest.clearAllMocks();
  supabase._chain.__queue = [];
});

describe('syncStudentEnrollment', () => {
  test('links to a teacher whose teaches[] matches curriculum + grade', async () => {
    supabase._chain.__queue.push({ data: [{ id: 't1', email: 'teacher1@a.com' }], error: null });
    readPreferences.mockResolvedValueOnce({
      'teacher1@a.com': { teaches: [{ curriculum: 'IB PYP', grade: 'Grade 4' }] },
    });

    await syncStudentEnrollment({ userId: 'student-1', curriculum: 'IB PYP', grade: 'Grade 4' });

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      [{ teacher_id: 't1', student_id: 'student-1', subject: 'IB PYP' }],
      { onConflict: 'teacher_id,student_id', ignoreDuplicates: true }
    );
  });

  test('no teachers in the curriculum at all -> readPreferences never called, no upsert', async () => {
    supabase._chain.__queue.push({ data: [], error: null });
    await syncStudentEnrollment({ userId: 'student-1', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(readPreferences).not.toHaveBeenCalled();
    expect(supabase._chain.upsert).not.toHaveBeenCalled();
  });

  test('teachers exist but none teach this grade -> no upsert', async () => {
    supabase._chain.__queue.push({ data: [{ id: 't1', email: 'teacher1@a.com' }], error: null });
    readPreferences.mockResolvedValueOnce({
      'teacher1@a.com': { teaches: [{ curriculum: 'IB PYP', grade: 'Grade 5' }] },
    });
    await syncStudentEnrollment({ userId: 'student-1', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(supabase._chain.upsert).not.toHaveBeenCalled();
  });
});

describe('syncTeacherEnrollment', () => {
  test('links to students matching any of the teaches[] combos', async () => {
    supabase._chain.__queue.push({
      data: [
        { id: 's1', grade: 'Grade 4', curriculum: 'IB PYP' },
        { id: 's2', grade: 'Grade 5', curriculum: 'IB PYP' },
      ],
      error: null,
    });

    await syncTeacherEnrollment({
      userId: 'teacher-1', curriculum: 'IB PYP', grade: 'Grade 4',
      teaches: [{ curriculum: 'IB PYP', grade: 'Grade 4' }],
    });

    expect(supabase._chain.upsert).toHaveBeenCalledWith(
      [{ teacher_id: 'teacher-1', student_id: 's1', subject: 'IB PYP' }],
      { onConflict: 'teacher_id,student_id', ignoreDuplicates: true }
    );
  });

  test('falls back to a single grade/curriculum when teaches[] is empty', async () => {
    supabase._chain.__queue.push({ data: [{ id: 's1', grade: 'Grade 4', curriculum: 'IB PYP' }], error: null });
    await syncTeacherEnrollment({ userId: 'teacher-1', curriculum: 'IB PYP', grade: 'Grade 4', teaches: [] });
    expect(supabase._chain.upsert).toHaveBeenCalled();
  });
});

describe('syncEnrollmentAfterProfileUpdate', () => {
  test('missing userId/curriculum/grade -> skipped entirely, no Supabase calls', async () => {
    await syncEnrollmentAfterProfileUpdate({ role: 'student', userId: null, curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('role student -> routes to syncStudentEnrollment', async () => {
    supabase._chain.__queue.push({ data: [], error: null });
    await syncEnrollmentAfterProfileUpdate({ role: 'student', userId: 's1', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(supabase.from).toHaveBeenCalledWith('users');
  });

  test('role parent -> no sync attempted (not student or teacher)', async () => {
    await syncEnrollmentAfterProfileUpdate({ role: 'parent', userId: 'p1', curriculum: 'IB PYP', grade: 'Grade 4' });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  test('a thrown error inside the sync is swallowed — never propagates', async () => {
    supabase._chain.__queue.push({ data: null, error: null });
    // Force an actual throw by making readPreferences reject once a teacher is found.
    supabase._chain.__queue = [];
    supabase._chain.__queue.push({ data: [{ id: 't1', email: 'teacher1@a.com' }], error: null });
    readPreferences.mockRejectedValueOnce(new Error('preferences store down'));

    await expect(
      syncEnrollmentAfterProfileUpdate({ role: 'student', userId: 's1', curriculum: 'IB PYP', grade: 'Grade 4' })
    ).resolves.toBeUndefined();
  });
});
