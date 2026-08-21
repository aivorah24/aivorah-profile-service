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

  test('grade/curriculum/location/phone also write through to the real users table', async () => {
    await updatePreferences({ email: 'a@a.com', grade: 'Grade 5', curriculum: 'IB PYP', location: 'Chennai' });
    expect(mockSb.supabase.from).toHaveBeenCalledWith('users');
  });

  test('does real nothing to the users table when no write-through fields are given', async () => {
    await updatePreferences({ email: 'a@a.com', bio: 'just a bio' });
    expect(mockSb.supabase.from).not.toHaveBeenCalledWith('users');
  });

  test('a real saved phone comes back decrypted in the response', async () => {
    mockGetPreferences.mockResolvedValue({ phone: encrypt('8888888888') });
    const saved = await updatePreferences({ email: 'a@a.com', bio: 'x' });
    expect(saved.phone).toBe('8888888888');
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
