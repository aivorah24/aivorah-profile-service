const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const { getPreferences, setPreferences, readPreferences } = require('../../services/preferences');

const originalFrom = mockSb.supabase.from;

beforeEach(() => {
  mockSb.reset();
  mockSb.supabase.from = originalFrom;
});

describe('getPreferences', () => {
  test('returns a real found preferences object, lowercased/trimmed email', async () => {
    mockSb.setTable('user_preferences', { data: { data: { bio: 'Hello' } }, error: null });

    const result = await getPreferences('  A@A.com  ');

    expect(result).toEqual({ bio: 'Hello' });
  });

  test('returns real null when no row exists', async () => {
    mockSb.setTable('user_preferences', { data: null, error: null });

    expect(await getPreferences('a@a.com')).toBeNull();
  });

  test('a real db error is swallowed, returns null (never throws)', async () => {
    mockSb.supabase.from = jest.fn(() => { throw new Error('db down'); });

    await expect(getPreferences('a@a.com')).resolves.toBeNull();
  });
});

describe('setPreferences', () => {
  test('merges real new updates onto the real existing preferences before upserting', async () => {
    mockSb.setTable('user_preferences', { data: { data: { bio: 'Old bio', theme: 'dark' } }, error: null });
    const upsertSpy = jest.fn(() => Promise.resolve({ data: {}, error: null }));
    mockSb.supabase.from = jest.fn((table) => {
      const chain = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        maybeSingle: jest.fn(() => Promise.resolve({ data: { data: { bio: 'Old bio', theme: 'dark' } }, error: null })),
        upsert: upsertSpy,
      };
      return chain;
    });

    await setPreferences('a@a.com', { bio: 'New bio' });

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ user_email: 'a@a.com', data: { bio: 'New bio', theme: 'dark' } }),
      { onConflict: 'user_email' }
    );
  });

  test('a real db error during upsert is swallowed, never throws', async () => {
    mockSb.supabase.from = jest.fn(() => { throw new Error('db down'); });

    await expect(setPreferences('a@a.com', { bio: 'x' })).resolves.toBeUndefined();
  });
});

describe('readPreferences', () => {
  test('maps real rows into a real email-keyed object', async () => {
    mockSb.setTable('user_preferences', { data: [
      { user_email: 'a@a.com', data: { bio: 'A' } },
      { user_email: 'b@b.com', data: { bio: 'B' } },
    ], error: null });

    const result = await readPreferences();

    expect(result).toEqual({ 'a@a.com': { bio: 'A' }, 'b@b.com': { bio: 'B' } });
  });

  test('a real db error is swallowed, returns an empty object', async () => {
    mockSb.supabase.from = jest.fn(() => { throw new Error('db down'); });

    await expect(readPreferences()).resolves.toEqual({});
  });
});
