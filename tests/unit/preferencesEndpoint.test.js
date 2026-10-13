const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockGetPreferences = jest.fn();
const mockSetPreferences = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/preferences', () => ({
  getPreferences: (...args) => mockGetPreferences(...args),
  setPreferences: (...args) => mockSetPreferences(...args),
}));

const mockSyncEnrollment = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/enrollment-service', () => ({ syncEnrollmentAfterProfileUpdate: (...args) => mockSyncEnrollment(...args) }));

jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

const { encrypt } = require('../../utils/encryption');
const { updatePreferences, fetchPreferences } = require('../../services/profile-service');

beforeEach(() => {
  jest.clearAllMocks();
  mockSb.reset();
  mockGetPreferences.mockResolvedValue(null);
  mockSetPreferences.mockResolvedValue(undefined);
});

describe('updatePreferences', () => {
  test('a real missing email throws a real 400', async () => {
    await expect(updatePreferences({})).rejects.toMatchObject({ status: 400 });
  });

  test('patches only the real truthy fields into setPreferences', async () => {
    mockGetPreferences.mockResolvedValue({ avatarStyle: 'gamer' });
    await updatePreferences({ email: 'A@Test.com', avatarStyle: 'gamer', bio: 'hi' });
    expect(mockSetPreferences).toHaveBeenCalledWith(
      'A@Test.com',
      expect.objectContaining({ avatarStyle: 'gamer', bio: 'hi' })
    );
  });

  test('a real comma-separated interests string is split into an array', async () => {
    await updatePreferences({ email: 'a@a.com', interests: 'space, dinosaurs ,music' });
    expect(mockSetPreferences).toHaveBeenCalledWith(
      'a@a.com',
      expect.objectContaining({ interests: ['space', 'dinosaurs', 'music'] })
    );
  });

  test('a real phone is encrypted before being saved to preferences and users', async () => {
    mockSb.setTable('users', { data: null, error: null });
    await updatePreferences({ email: 'a@a.com', phone: '9999999999' });
    const savedPatch = mockSetPreferences.mock.calls[0][1];
    expect(savedPatch.phone).not.toBe('9999999999');
    expect(savedPatch.phone.split(':').length).toBe(3);
  });

  test('a legacy "NCERT" curriculum is saved as CBSE', async () => {
    await updatePreferences({ email: 'a@a.com', curriculum: 'NCERT' });
    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({ curriculum: 'CBSE' }));
  });

  test('fetchPreferences returns CBSE for a legacy NCERT blob (incl. teaches/children)', async () => {
    mockGetPreferences.mockResolvedValue({ curriculum: 'ncert', teaches: [{ grade: 'Grade 8', curriculum: 'NCERT' }], children: [{ name: 'A', curriculum: 'NCERT' }] });
    const rec = await fetchPreferences('a@a.com');
    expect(rec.curriculum).toBe('CBSE');
    expect(rec.teaches[0].curriculum).toBe('CBSE');
    expect(rec.children[0].curriculum).toBe('CBSE');
  });

  test('grade/curriculum/location/phone also write through to the real users table', async () => {
    await updatePreferences({ email: 'a@a.com', grade: 'Grade 5', curriculum: 'IB PYP', location: 'Chennai' });
    expect(mockSb.supabase.from).toHaveBeenCalledWith('users');
  });

  test('does real nothing to the users table when no write-through fields are given', async () => {
    await updatePreferences({ email: 'a@a.com', bio: 'just a bio' });
    expect(mockSb.supabase.from).not.toHaveBeenCalledWith('users');
  });

  // Regression tests for the "Gender/DOB/State missing on re-login" bug
  // (2026-08-26): gender/dob/state/country used to live ONLY in
  // user_preferences, so a single failed/slow GET /user/preferences at login
  // silently dropped them while grade/curriculum/location/phone (already
  // users-table columns) never did. They now get the same write-through.
  test('gender/dob/state/country also write through to the real users table', async () => {
    await updatePreferences({ email: 'a@a.com', gender: 'Female', dob: '15/06/2012', state: 'Karnataka', country: 'India' });
    expect(mockSb.supabase.from).toHaveBeenCalledWith('users');
  });

  test('gender/dob/state/country write through to users with their exact real values', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: null, error: null })) }));
    const originalFrom = mockSb.supabase.from;
    mockSb.supabase.from = jest.fn((table) => (table === 'users' ? { update: updateSpy } : originalFrom(table)));

    await updatePreferences({ email: 'a@a.com', gender: 'Female', dob: '15/06/2012', state: 'Karnataka', country: 'India' });

    // dob is converted DD/MM/YYYY -> ISO before hitting `users.dob` (a real
    // Postgres `date` column) — see ddmmyyyyToIso's doc comment.
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ gender: 'Female', dob: '2012-06-15', state: 'Karnataka', country: 'India' })
    );

    mockSb.supabase.from = originalFrom;
  });

  test('gender/dob/state/country are still saved to preferences too (old path untouched)', async () => {
    await updatePreferences({ email: 'a@a.com', gender: 'Female', dob: '15/06/2012', state: 'Karnataka', country: 'India' });

    expect(mockSetPreferences).toHaveBeenCalledWith(
      'a@a.com',
      expect.objectContaining({ gender: 'Female', dob: '15/06/2012', state: 'Karnataka', country: 'India' })
    );
  });

  test('a real saved phone comes back decrypted in the response', async () => {
    mockGetPreferences.mockResolvedValue({ phone: encrypt('8888888888') });
    const saved = await updatePreferences({ email: 'a@a.com', bio: 'x' });
    expect(saved.phone).toBe('8888888888');
  });

  // Regression test for Bug #9 (second finding, 2026-08-28): switching from an
  // uploaded photo to a built-in avatar left the header/sidebar showing the
  // stale photo forever after a refresh. Root cause: `if (photoUrl != null)`
  // treated an explicit `photoUrl: null` (the frontend's "clear it" signal)
  // identically to "field not provided at all" — so there was NO path,
  // anywhere, that could ever null out the authoritative `users.photo_url`
  // column once a real photo had been uploaded.
  test('an explicit photoUrl: null clears the stored preference AND write-throughs the clear to users.photo_url', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: null, error: null })) }));
    const originalFrom = mockSb.supabase.from;
    mockSb.supabase.from = jest.fn((table) => (table === 'users' ? { update: updateSpy } : originalFrom(table)));

    await updatePreferences({ email: 'a@a.com', avatarStyle: 'champion', photoUrl: null });

    expect(mockSetPreferences).toHaveBeenCalledWith(
      'a@a.com',
      expect.objectContaining({ avatarStyle: 'champion', photoUrl: null })
    );
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ photo_url: null }));

    mockSb.supabase.from = originalFrom;
  });

  test('omitting photoUrl entirely (not selecting a new avatar) leaves users.photo_url untouched', async () => {
    await updatePreferences({ email: 'a@a.com', bio: 'just a bio' });
    expect(mockSb.supabase.from).not.toHaveBeenCalledWith('users');
  });

  // Regression test: SetPasswordScreen.tsx clears mustChangePassword via
  // THIS endpoint (not the monolith's /user/clear-must-change-password,
  // which writes to a different Supabase project than /user/sync reads
  // from - see that screen's fetch call for the full bug).
  test('mustChangePassword:false is saved to preferences', async () => {
    await updatePreferences({ email: 'a@a.com', mustChangePassword: false });
    expect(mockSetPreferences).toHaveBeenCalledWith(
      'a@a.com',
      expect.objectContaining({ mustChangePassword: false }),
    );
  });

  test('omitting mustChangePassword entirely leaves it untouched (not force-set to false)', async () => {
    await updatePreferences({ email: 'a@a.com', bio: 'just a bio' });
    const savedPatch = mockSetPreferences.mock.calls[0][1];
    expect(savedPatch).not.toHaveProperty('mustChangePassword');
  });
});

describe('fetchPreferences', () => {
  test('a real empty email returns null without querying preferences (no full-table exposure)', async () => {
    const result = await fetchPreferences('');
    expect(result).toBeNull();
    expect(mockGetPreferences).not.toHaveBeenCalled();
  });

  test('a real found record has its phone decrypted', async () => {
    mockGetPreferences.mockResolvedValue({ phone: encrypt('7777777777'), bio: 'hi' });
    const result = await fetchPreferences('a@a.com');
    expect(result.phone).toBe('7777777777');
    expect(result.bio).toBe('hi');
  });

  test('no real record found returns null', async () => {
    mockGetPreferences.mockResolvedValue(null);
    const result = await fetchPreferences('a@a.com');
    expect(result).toBeNull();
  });
});
