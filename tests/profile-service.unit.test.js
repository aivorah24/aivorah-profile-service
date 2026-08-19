// Unit tests for services/profile-service.js — updateProfile and
// uploadProfilePhoto. Supabase/Cloudinary/preferences/enrollment mocked.

jest.mock('../services/supabase', () => {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  };
  return { from: jest.fn(() => chain), _chain: chain };
});

jest.mock('../services/preferences', () => ({
  setPreferences: jest.fn().mockResolvedValue(undefined),
  readPreferences: jest.fn(),
}));

jest.mock('../services/enrollment-service', () => ({
  syncEnrollmentAfterProfileUpdate: jest.fn().mockResolvedValue(undefined),
}));

const mockCloudinaryUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { config: jest.fn(), uploader: { upload: (...args) => mockCloudinaryUpload(...args) } },
}));

jest.mock('../utils/encryption', () => ({
  encrypt: jest.fn((v) => `encrypted:${v}`),
  decrypt: jest.fn((v) => (typeof v === 'string' ? v.replace(/^encrypted:/, '') : v)),
}));

const supabase = require('../services/supabase');
const { setPreferences } = require('../services/preferences');
const { syncEnrollmentAfterProfileUpdate } = require('../services/enrollment-service');
const { updateProfile, uploadProfilePhoto } = require('../services/profile-service');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('updateProfile', () => {
  test('missing email throws a 400 error', async () => {
    await expect(updateProfile({})).rejects.toMatchObject({ status: 400, message: 'email required' });
  });

  test('student completing onboarding without grade throws a 400 error', async () => {
    await expect(
      updateProfile({ email: 'a@a.com', role: 'student', curriculum: 'IB PYP', complete: true })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('grade and curriculum') });
  });

  test('successful update returns the profile and triggers enrollment sync', async () => {
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '1', name: 'A', email: 'a@a.com', role: 'student', grade: 'Grade 4', curriculum: 'IB PYP', onboarding_complete: true },
      error: null,
    });

    const result = await updateProfile({ email: 'a@a.com', role: 'student', name: 'A', grade: 'Grade 4', curriculum: 'IB PYP', complete: true });

    expect(result.onboardingComplete).toBe(true);
    expect(syncEnrollmentAfterProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'student', userId: '1', curriculum: 'IB PYP', grade: 'Grade 4' })
    );
  });

  test('brand-new user (PGRST116) falls back to upsert', async () => {
    supabase._chain.single
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
      .mockResolvedValueOnce({ data: { id: '2', email: 'new@a.com', role: 'teacher', onboarding_complete: true }, error: null });

    const result = await updateProfile({ email: 'new@a.com', role: 'teacher', name: 'New', complete: true });

    expect(supabase._chain.upsert).toHaveBeenCalled();
    expect(result.id).toBe('2');
  });

  test('a real Supabase error throws a 500', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: null, error: { code: 'OTHER', message: 'db exploded' } });
    await expect(updateProfile({ email: 'a@a.com', role: 'teacher', name: 'A' })).rejects.toMatchObject({
      status: 500, message: 'db exploded',
    });
  });

  test('no users-table fields to update, but user does not exist -> 404', async () => {
    // 1st maybeSingle: role lookup (no bodyRole given, so currentRole resolution hits the DB)
    // 2nd maybeSingle: the empty-patch "just fetch existing row" lookup
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(updateProfile({ email: 'nobody@a.com' })).rejects.toMatchObject({ status: 404, message: 'user not found' });
  });

  test('teaches/children/dob/gender/phone are all written in a SINGLE setPreferences call', async () => {
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '3', email: 't@a.com', role: 'teacher', onboarding_complete: true },
      error: null,
    });

    await updateProfile({
      email: 't@a.com', role: 'teacher', name: 'T', complete: true,
      teaches: [{ curriculum: 'IB PYP', grade: 'Grade 4' }], dob: '01/01/1990', gender: 'Male', phone: '9999999999',
    });

    expect(setPreferences).toHaveBeenCalledTimes(1);
    expect(setPreferences).toHaveBeenCalledWith('t@a.com', expect.objectContaining({
      teaches: [{ curriculum: 'IB PYP', grade: 'Grade 4' }],
      dob: '01/01/1990',
      gender: 'Male',
      phone: 'encrypted:9999999999',
    }));
  });

  test('phone is decrypted in the returned profile', async () => {
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '4', email: 'a@a.com', role: 'parent', phone: 'encrypted:9999999999', onboarding_complete: true },
      error: null,
    });
    const result = await updateProfile({ email: 'a@a.com', role: 'parent', name: 'A' });
    expect(result.phone).toBe('9999999999');
  });
});

describe('uploadProfilePhoto', () => {
  test('missing userEmail throws a 400 error', async () => {
    await expect(uploadProfilePhoto({ base64: 'abc' })).rejects.toMatchObject({ status: 400, message: 'userEmail required' });
  });

  test('missing base64 throws a 400 error', async () => {
    await expect(uploadProfilePhoto({ userEmail: 'a@a.com' })).rejects.toMatchObject({ status: 400, message: 'base64 image required' });
  });

  test('successful upload returns the photo URL and saves it', async () => {
    mockCloudinaryUpload.mockResolvedValueOnce({ secure_url: 'https://cloudinary.com/a.jpg' });
    const result = await uploadProfilePhoto({ userEmail: 'a@a.com', base64: 'ZmFrZQ==' });
    expect(result.photoUrl).toBe('https://cloudinary.com/a.jpg');
    expect(supabase._chain.update).toHaveBeenCalledWith({ photo_url: 'https://cloudinary.com/a.jpg' });
  });
});
