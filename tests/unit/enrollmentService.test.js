const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockReadPreferences = jest.fn();
jest.mock('../../services/preferences', () => ({ readPreferences: (...args) => mockReadPreferences(...args) }));

const { syncStudentEnrollment, syncTeacherEnrollment, syncEnrollmentAfterProfileUpdate } = require('../../services/enrollment-service');

const originalFrom = mockSb.supabase.from;

beforeEach(() => {
  jest.clearAllMocks();
  mockSb.reset();
  mockSb.supabase.from = originalFrom;
  mockReadPreferences.mockResolvedValue({});
});

describe('syncStudentEnrollment', () => {
  test('links to a real teacher whose teaches[] matches both curriculum AND grade', async () => {
    const upsertSpy = jest.fn(() => Promise.resolve({ data: {}, error: null }));
    const deleteChain = { eq: jest.fn(() => deleteChain), not: jest.fn(() => Promise.resolve({ data: {}, error: null })) };
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { select: jest.fn(() => ({ eq: jest.fn(() => ({ in: jest.fn(() => Promise.resolve({
          data: [{ id: 't1', email: 'teacher1@a.com' }, { id: 't2', email: 'teacher2@a.com' }],
        })) })) })) };
      }
      if (table === 'teacher_student') {
        return { delete: jest.fn(() => deleteChain), upsert: upsertSpy };
      }
      return { select: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: [] })) })) };
    });
    mockReadPreferences.mockResolvedValue({
      'teacher1@a.com': { teaches: [{ curriculum: 'IB PYP', grade: 'Grade 4' }] },
      'teacher2@a.com': { teaches: [{ curriculum: 'IB PYP', grade: 'Grade 5' }] }, // wrong grade — excluded
    });

    await syncStudentEnrollment({ userId: 's1', curriculum: 'IB PYP', grade: 'Grade 4' });

    expect(upsertSpy).toHaveBeenCalledWith(
      [{ teacher_id: 't1', student_id: 's1', subject: 'IB PYP' }],
      { onConflict: 'teacher_id,student_id', ignoreDuplicates: true }
    );
  });

  test('does nothing (no upsert) when no real teacher matches', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { select: jest.fn(() => ({ eq: jest.fn(() => ({ in: jest.fn(() => Promise.resolve({ data: [] })) })) })) };
      }
      return { upsert: jest.fn(), delete: jest.fn() };
    });

    await expect(syncStudentEnrollment({ userId: 's1', curriculum: 'IB PYP', grade: 'Grade 4' })).resolves.toBeUndefined();
    expect(mockReadPreferences).not.toHaveBeenCalled(); // short-circuits before reading prefs when there are zero teachers
  });
});

describe('syncStudentEnrollment — legacy NCERT', () => {
  test('a CBSE student matches teachers still stored as NCERT', async () => {
    const upsertSpy = jest.fn(() => Promise.resolve({ data: {}, error: null }));
    const deleteChain = { eq: jest.fn(() => deleteChain), not: jest.fn(() => Promise.resolve({ data: {}, error: null })) };
    const inSpy = jest.fn(() => Promise.resolve({ data: [{ id: 't1', email: 'teacher1@a.com' }] }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { select: jest.fn(() => ({ eq: jest.fn(() => ({ in: inSpy })) })) };
      return { delete: jest.fn(() => deleteChain), upsert: upsertSpy };
    });
    mockReadPreferences.mockResolvedValue({ 'teacher1@a.com': { teaches: [{ curriculum: 'NCERT', grade: 'Grade 8' }] } });

    await syncStudentEnrollment({ userId: 's1', curriculum: 'CBSE', grade: 'Grade 8' });

    expect(inSpy).toHaveBeenCalledWith('curriculum', ['CBSE', 'NCERT']);
    expect(upsertSpy).toHaveBeenCalledWith(
      [{ teacher_id: 't1', student_id: 's1', subject: 'CBSE' }],
      { onConflict: 'teacher_id,student_id', ignoreDuplicates: true }
    );
  });
});

describe('syncTeacherEnrollment', () => {
  test('links to real students matching any of the teacher\'s taught curriculum+grade combos', async () => {
    const upsertSpy = jest.fn(() => Promise.resolve({ data: {}, error: null }));
    const deleteChain = { eq: jest.fn(() => deleteChain), not: jest.fn(() => Promise.resolve({ data: {}, error: null })) };
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { select: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({
          data: [
            { id: 's1', grade: 'Grade 4', curriculum: 'IB PYP' },
            { id: 's2', grade: 'Grade 5', curriculum: 'IB PYP' }, // not taught — excluded
          ],
        })) })) };
      }
      if (table === 'teacher_student') {
        return { delete: jest.fn(() => deleteChain), upsert: upsertSpy };
      }
      return {};
    });

    await syncTeacherEnrollment({ userId: 't1', curriculum: 'IB PYP', grade: 'Grade 4', teaches: [{ curriculum: 'IB PYP', grade: 'Grade 4' }] });

    expect(upsertSpy).toHaveBeenCalledWith(
      [{ teacher_id: 't1', student_id: 's1', subject: 'IB PYP' }],
      { onConflict: 'teacher_id,student_id', ignoreDuplicates: true }
    );
  });
});

describe('syncEnrollmentAfterProfileUpdate — routing and safety', () => {
  test('does real nothing when userId/curriculum/grade are missing', async () => {
    mockSb.supabase.from = jest.fn(() => { throw new Error('should not be called'); });

    await expect(syncEnrollmentAfterProfileUpdate({ role: 'student', userId: null, curriculum: 'IB PYP', grade: 'Grade 4' })).resolves.toBeUndefined();
  });

  test('routes a real student role to syncStudentEnrollment (queries users for teachers)', async () => {
    const usersFrom = jest.fn(() => ({ select: jest.fn(() => ({ eq: jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: [] })) })) })) }));
    mockSb.supabase.from = usersFrom;

    await syncEnrollmentAfterProfileUpdate({ role: 'student', userId: 's1', curriculum: 'IB PYP', grade: 'Grade 4' });

    expect(usersFrom).toHaveBeenCalledWith('users');
  });

  test('a real failure inside the sync is swallowed — never throws, never blocks the profile save', async () => {
    mockSb.supabase.from = jest.fn(() => { throw new Error('db exploded'); });

    await expect(syncEnrollmentAfterProfileUpdate({ role: 'student', userId: 's1', curriculum: 'IB PYP', grade: 'Grade 4' })).resolves.toBeUndefined();
  });

  test('an unrecognized role (e.g. parent) does real nothing', async () => {
    mockSb.supabase.from = jest.fn(() => { throw new Error('should not be called'); });

    await expect(syncEnrollmentAfterProfileUpdate({ role: 'parent', userId: 'p1', curriculum: 'IB PYP', grade: 'Grade 4' })).resolves.toBeUndefined();
  });
});
