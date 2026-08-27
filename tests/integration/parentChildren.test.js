// Integration tests for POST /parent/:parentEmail/children/create-student and
// POST /parent/:parentEmail/children — ported from the monolith
// (server/routes/parent.js), only the 2 routes the teacher "Add a parent
// profile" flow actually calls. See routes/parent.js's own header comment.
const mockSendCredentialsEmail = jest.fn();
jest.mock('../../services/mailer', () => ({
  sendCredentialsEmail: (...args) => mockSendCredentialsEmail(...args),
}));

const mockUsersMaybeSingle = jest.fn();
const mockUsersSingle = jest.fn();
const mockUsersInsert = jest.fn();
const mockParentChildrenInsert = jest.fn();
const mockStudentStatsUpsert = jest.fn();
const mockUserPrefsMaybeSingle = jest.fn();
const mockUserPrefsUpsert = jest.fn();
const mockCreateUser = jest.fn();
const mockDeleteUser = jest.fn();

jest.mock('../../services/supabase', () => ({
  auth: {
    admin: {
      createUser: (...args) => mockCreateUser(...args),
      deleteUser: (...args) => mockDeleteUser(...args),
    },
  },
  from: jest.fn((table) => {
    if (table === 'users') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockUsersMaybeSingle, single: mockUsersSingle }) }),
        insert: mockUsersInsert,
      };
    }
    if (table === 'parent_children') {
      return { insert: mockParentChildrenInsert };
    }
    if (table === 'student_stats') {
      return { upsert: mockStudentStatsUpsert };
    }
    if (table === 'user_preferences') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockUserPrefsMaybeSingle }) }),
        upsert: mockUserPrefsUpsert,
      };
    }
    return { select: jest.fn(), eq: jest.fn() };
  }),
}));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  mockSendCredentialsEmail.mockResolvedValue(undefined);
  mockUsersMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockCreateUser.mockResolvedValue({ data: { user: { id: 'new-user-1' } }, error: null });
  mockUsersInsert.mockResolvedValue({ error: null });
  mockParentChildrenInsert.mockResolvedValue({ error: null });
  mockStudentStatsUpsert.mockResolvedValue({ error: null });
  mockUserPrefsMaybeSingle.mockResolvedValue({ data: null, error: null });
  mockUserPrefsUpsert.mockResolvedValue({ error: null });
});

describe('POST /parent/:parentEmail/children/create-student', () => {
  test('missing name/grade/curriculum -> 400', async () => {
    const res = await request(app).post('/parent/teacher@school.com/children/create-student').send({ name: 'Kid' });
    expect(res.status).toBe(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  test('a real email already in use -> 409, never creates an auth user', async () => {
    mockUsersMaybeSingle.mockResolvedValue({ data: { id: 'existing' }, error: null });
    const res = await request(app).post('/parent/teacher@school.com/children/create-student')
      .send({ name: 'Kid', grade: 'Grade 3', curriculum: 'IB PYP', email: 'kid@a.com' });
    expect(res.status).toBe(409);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  test('a real successful creation with a provided email sends real credentials and returns success', async () => {
    const res = await request(app).post('/parent/teacher@school.com/children/create-student')
      .send({ name: 'kid smith', grade: 'Grade 3', curriculum: 'IB PYP', email: 'kid@a.com', password: 'realpass1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Response echoes the trimmed input name as-is (matches the monolith
    // exactly) — only the DB write goes through toTitleCase().
    expect(res.body.child.name).toBe('kid smith');
    expect(res.body.child.email).toBe('kid@a.com');
    expect(res.body.child.generatedPassword).toBeUndefined(); // real password was provided
    expect(mockCreateUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'kid@a.com', password: 'realpass1', email_confirm: false }));
    expect(mockParentChildrenInsert).toHaveBeenCalledWith({ parent_email: 'teacher@school.com', child_id: 'new-user-1' });
    expect(mockSendCredentialsEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'kid@a.com', childName: 'kid smith' }));
  });

  test('no real email provided -> auto-generates a login id, never emails credentials', async () => {
    const res = await request(app).post('/parent/teacher@school.com/children/create-student')
      .send({ name: 'Kid', grade: 'Grade 3', curriculum: 'IB PYP' });

    expect(res.status).toBe(200);
    expect(res.body.child.email).toMatch(/@aivorah\.student$/);
    expect(res.body.child.generatedPassword).toBeTruthy(); // no password given -> real one generated
    expect(mockSendCredentialsEmail).not.toHaveBeenCalled();
  });

  test('a real users-table insert failure rolls back the auth user it just created', async () => {
    mockUsersInsert.mockResolvedValue({ error: { message: 'insert failed' } });
    const res = await request(app).post('/parent/teacher@school.com/children/create-student')
      .send({ name: 'Kid', grade: 'Grade 3', curriculum: 'IB PYP', email: 'kid@a.com' });

    expect(res.status).toBe(500);
    expect(mockDeleteUser).toHaveBeenCalledWith('new-user-1');
  });
});

describe('POST /parent/:parentEmail/children (link existing)', () => {
  test('missing childEmail -> 400', async () => {
    const res = await request(app).post('/parent/teacher@school.com/children').send({});
    expect(res.status).toBe(400);
  });

  test('a real unknown child email -> 404 with a real helpful message', async () => {
    mockUsersSingle.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const res = await request(app).post('/parent/teacher@school.com/children').send({ childEmail: 'ghost@a.com' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Ask your child to register first/);
  });

  test('a real successful link returns the real child info', async () => {
    mockUsersSingle.mockResolvedValue({ data: { id: 'child-1', name: 'Kid', email: 'kid@a.com', grade: 'Grade 3', school: 'Riverdale' }, error: null });
    const res = await request(app).post('/parent/teacher@school.com/children').send({ childEmail: 'kid@a.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.child).toEqual({ id: 'child-1', name: 'Kid', email: 'kid@a.com', grade: 'Grade 3', school: 'Riverdale' });
    expect(mockParentChildrenInsert).toHaveBeenCalledWith({ parent_email: 'teacher@school.com', child_id: 'child-1' });
  });

  test('a real already-linked child -> 409', async () => {
    mockUsersSingle.mockResolvedValue({ data: { id: 'child-1', name: 'Kid', email: 'kid@a.com' }, error: null });
    mockParentChildrenInsert.mockResolvedValue({ error: { code: '23505' } });
    const res = await request(app).post('/parent/teacher@school.com/children').send({ childEmail: 'kid@a.com' });

    expect(res.status).toBe(409);
  });
});
