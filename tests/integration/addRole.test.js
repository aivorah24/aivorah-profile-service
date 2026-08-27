// Integration tests for PATCH /user/add-role — ported from the monolith
// (server/routes/user.js). Adds a role to user_preferences.data.roles,
// merged with the primary users.role.
const mockGetPreferences = jest.fn();
const mockSetPreferences = jest.fn();
jest.mock('../../services/preferences', () => ({
  getPreferences: (...args) => mockGetPreferences(...args),
  setPreferences: (...args) => mockSetPreferences(...args),
}));

const mockUsersMaybeSingle = jest.fn();
jest.mock('../../services/supabase', () => ({
  from: jest.fn((table) => {
    if (table === 'users') {
      return { select: () => ({ eq: () => ({ maybeSingle: mockUsersMaybeSingle }) }) };
    }
    return { select: jest.fn(), eq: jest.fn() };
  }),
}));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  mockSetPreferences.mockResolvedValue(undefined);
});

describe('PATCH /user/add-role', () => {
  test('missing email or role -> 400, never touches Supabase', async () => {
    const res = await request(app).patch('/user/add-role').send({ email: 'a@a.com' });
    expect(res.status).toBe(400);
    expect(mockUsersMaybeSingle).not.toHaveBeenCalled();
  });

  test('an invalid role -> 400', async () => {
    const res = await request(app).patch('/user/add-role').send({ email: 'a@a.com', role: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid role');
  });

  test('a real unknown user -> 404', async () => {
    mockUsersMaybeSingle.mockResolvedValue({ data: null, error: null });
    const res = await request(app).patch('/user/add-role').send({ email: 'ghost@a.com', role: 'parent' });
    expect(res.status).toBe(404);
  });

  test('a real teacher adding a parent role merges primary role + new role', async () => {
    mockUsersMaybeSingle.mockResolvedValue({ data: { id: 'u1', role: 'teacher' }, error: null });
    mockGetPreferences.mockResolvedValue(null);

    const res = await request(app).patch('/user/add-role').send({ email: 'teacher@school.com', role: 'parent' });

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['teacher', 'parent']);
    expect(mockSetPreferences).toHaveBeenCalledWith('teacher@school.com', expect.objectContaining({ roles: ['teacher', 'parent'] }));
  });

  test('adding a role the user already has -> no real duplicate in the merged set', async () => {
    mockUsersMaybeSingle.mockResolvedValue({ data: { id: 'u1', role: 'teacher' }, error: null });
    mockGetPreferences.mockResolvedValue({ roles: ['teacher', 'parent'] });

    const res = await request(app).patch('/user/add-role').send({ email: 'teacher@school.com', role: 'parent' });

    expect(res.body.roles).toEqual(['teacher', 'parent']);
  });
});
