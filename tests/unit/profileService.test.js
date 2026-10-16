const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockSetPreferences = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/preferences', () => ({ setPreferences: (...args) => mockSetPreferences(...args) }));

const mockSyncEnrollment = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/enrollment-service', () => ({ syncEnrollmentAfterProfileUpdate: (...args) => mockSyncEnrollment(...args) }));

const mockCloudinaryUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { upload: (...args) => mockCloudinaryUpload(...args) },
  },
}));

const { updateProfile, uploadProfilePhoto } = require('../../services/profile-service');

const originalFrom = mockSb.supabase.from;

function usersRow(overrides = {}) {
  return {
    id: 'u1', name: 'A Student', email: 'a@a.com', role: 'student',
    grade: 'Grade 4', school: null, curriculum: 'IB PYP', location: 'Hyderabad',
    phone: null, onboarding_complete: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSb.reset();
  mockSb.supabase.from = originalFrom;
  mockSetPreferences.mockResolvedValue(undefined);
  mockSyncEnrollment.mockResolvedValue(undefined);
});

describe('updateProfile — validation', () => {
  test('a real missing email throws a real 400', async () => {
    await expect(updateProfile({ name: 'X' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('updateProfile — patch building', () => {
  test('updates a real users row with only the real truthy fields provided', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ name: 'New Name' }), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: 'New Name' });

    expect(updateSpy).toHaveBeenCalledWith({ name: 'New Name' });
  });

  test('avatarStyle and learningStyle from a partial "Save & Back to Home" are persisted to preferences', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: 'X', avatarStyle: 'gamer', learningStyle: 'visual' });

    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({ avatarStyle: 'gamer', learningStyle: 'visual' }));
  });

  test('a real name is trimmed before being saved', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: '  Padded Name  ' });

    expect(updateSpy).toHaveBeenCalledWith({ name: 'Padded Name' });
  });

  test('no truthy fields provided reads and returns the real existing row without writing', async () => {
    const updateSpy = jest.fn();
    const selectSpy = jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(() => Promise.resolve({ data: usersRow() })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy, select: selectSpy };
      return originalFrom(table);
    });

    const result = await updateProfile({ email: 'a@a.com' });

    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.email).toBe('a@a.com');
  });

  test('a real user not found (neither updated nor existing) throws a real 404', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: null, error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    await expect(updateProfile({ email: 'a@a.com', name: 'X' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateProfile — NCERT is stored as CBSE', () => {
  test('curriculum and teaches[] NCERT are written as CBSE; legacy row reads back CBSE', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ curriculum: 'NCERT' }), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => (table === 'users' ? { update: updateSpy } : originalFrom(table)));

    const out = await updateProfile({ email: 'a@a.com', curriculum: 'ncert', teaches: [{ grade: 'Grade 8', curriculum: 'NCERT' }] });

    expect(updateSpy).toHaveBeenCalledWith({ curriculum: 'CBSE' });
    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({ teaches: [{ grade: 'Grade 8', curriculum: 'CBSE' }] }));
    expect(out.curriculum).toBe('CBSE');
  });
});

describe('updateProfile — dob/gender/state/country write through to users', () => {
  // Regression tests for the "Gender/DOB/State missing on re-login" bug
  // (2026-08-26): these 4 fields used to only ever be forwarded into
  // user_preferences (see preferencesPatch below), never into the `users`
  // row this function updates — so a single failed/slow GET
  // /user/preferences at login silently dropped them while grade/school/
  // curriculum (already `users` columns, updated right here) never did.
  test('a real dob/gender/state/country are written straight into the users row', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' }), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' });

    // dob is converted DD/MM/YYYY -> ISO before hitting `users.dob` (a real
    // Postgres `date` column) — see ddmmyyyyToIso's doc comment.
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ dob: '2012-06-15', gender: 'Female', state: 'Karnataka', country: 'India' })
    );
  });

  test('a real saved dob/gender/state/country come back in the response', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' }), error: null })) })) })) })) };
      }
      return originalFrom(table);
    });

    const result = await updateProfile({ email: 'a@a.com', dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' });

    expect(result).toMatchObject({ dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' });
  });

  test('dob/gender still also reach preferences too (old path untouched, not yet removed)', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(), error: null })) })) })) })) };
      }
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', dob: '15/06/2012', gender: 'Female' });

    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({ dob: '15/06/2012', gender: 'Female' }));
  });

  test('no dob/gender/state/country provided leaves the users row and response untouched', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ name: 'New Name' }), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    const result = await updateProfile({ email: 'a@a.com', name: 'New Name' });

    expect(updateSpy).toHaveBeenCalledWith({ name: 'New Name' });
    expect(result.dob).toBeNull();
    expect(result.gender).toBeNull();
    expect(result.state).toBeNull();
    expect(result.country).toBeNull();
  });
});

describe('updateProfile — onboarding completion', () => {
  test('a real student completing onboarding without grade/curriculum is rejected', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(() => Promise.resolve({ data: { role: 'student' } })) })) })) };
      }
      return originalFrom(table);
    });

    await expect(updateProfile({ email: 'a@a.com', complete: true })).rejects.toMatchObject({ status: 400 });
  });

  test('a real student completing onboarding WITH grade+curriculum succeeds', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ onboarding_complete: true }), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(() => Promise.resolve({ data: { role: 'student' } })) })) })),
          update: updateSpy,
        };
      }
      return originalFrom(table);
    });

    const result = await updateProfile({ email: 'a@a.com', complete: true, grade: 'Grade 4', curriculum: 'IB PYP' });

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ onboarding_complete: true }));
    expect(result.onboardingComplete).toBe(true);
  });

  test('a real non-student role completing onboarding needs no grade/curriculum', async () => {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ role: 'teacher', onboarding_complete: true }), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return {
          select: jest.fn(() => ({ eq: jest.fn(() => ({ maybeSingle: jest.fn(() => Promise.resolve({ data: { role: 'teacher' } })) })) })),
          update: updateSpy,
        };
      }
      return originalFrom(table);
    });

    await expect(updateProfile({ email: 'a@a.com', role: 'teacher', complete: true })).resolves.toBeDefined();
  });
});

describe('updateProfile — upsert fallback (PGRST116)', () => {
  test('falls back to a real upsert when the update matched zero rows', async () => {
    const upsertSpy = jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ name: 'New' }), error: null })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return {
          update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })) })) })) })),
          upsert: upsertSpy,
        };
      }
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: 'New' });

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@a.com', name: 'New' }),
      { onConflict: 'email' }
    );
  });

  test('a real non-PGRST116 db error throws a real 500, no upsert fallback', async () => {
    const upsertSpy = jest.fn();
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return {
          update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: null, error: { code: 'OTHER', message: 'db exploded' } })) })) })) })),
          upsert: upsertSpy,
        };
      }
      return originalFrom(table);
    });

    await expect(updateProfile({ email: 'a@a.com', name: 'New' })).rejects.toMatchObject({ status: 500 });
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe('updateProfile — preferences sub-patch and enrollment sync', () => {
  test('collects real teaches/children/dob/gender/phone into one real setPreferences call', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(), error: null })) })) })) })) };
      }
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: 'X', dob: '2015-01-01', gender: 'F', phone: '9999999999' });

    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({ dob: '2015-01-01', gender: 'F' }));
  });

  test('does real nothing to preferences when none of those fields are provided', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(), error: null })) })) })) })) };
      }
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: 'X' });

    expect(mockSetPreferences).not.toHaveBeenCalled();
  });

  test('always calls the real enrollment sync after a successful update', async () => {
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(), error: null })) })) })) })) };
      }
      return originalFrom(table);
    });

    await updateProfile({ email: 'a@a.com', name: 'X' });

    expect(mockSyncEnrollment).toHaveBeenCalledWith(expect.objectContaining({ role: 'student' }));
  });
});

describe('updateProfile — response shape', () => {
  test('decrypts a real stored phone number in the response', async () => {
    const { encrypt } = require('../../utils/encryption');
    const encryptedPhone = encrypt('9999999999');
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return { update: jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow({ phone: encryptedPhone }), error: null })) })) })) })) };
      }
      return originalFrom(table);
    });

    const result = await updateProfile({ email: 'a@a.com', name: 'X' });

    expect(result.phone).toBe('9999999999');
  });
});

describe('uploadProfilePhoto', () => {
  test('a real missing userEmail throws a real 400', async () => {
    await expect(uploadProfilePhoto({ base64: 'abc' })).rejects.toMatchObject({ status: 400 });
  });

  test('a real missing base64 throws a real 400', async () => {
    await expect(uploadProfilePhoto({ userEmail: 'a@a.com' })).rejects.toMatchObject({ status: 400 });
  });

  test('a real successful upload returns the real Cloudinary secure_url and saves it', async () => {
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://cloudinary/a.png' });
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => Promise.resolve({ data: {}, error: null })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') return { update: updateSpy };
      return originalFrom(table);
    });

    const result = await uploadProfilePhoto({ userEmail: 'a@a.com', base64: 'abc123' });

    expect(result.photoUrl).toBe('https://cloudinary/a.png');
    expect(updateSpy).toHaveBeenCalledWith({ photo_url: 'https://cloudinary/a.png' });
  });
});

describe('updateProfile — IB curriculum/grade ranges', () => {
  function withExisting(row) {
    const updateSpy = jest.fn(() => ({ eq: jest.fn(() => ({ select: jest.fn(() => ({ single: jest.fn(() => Promise.resolve({ data: usersRow(row), error: null })) })) })) }));
    mockSb.supabase.from = jest.fn((table) => {
      if (table === 'users') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
          update: updateSpy,
        };
      }
      return originalFrom(table);
    });
    return updateSpy;
  }

  test('an IB DP student changing to Grade 7 is rejected with the reason', async () => {
    const updateSpy = withExisting({ role: 'student', grade: 'Grade 11', curriculum: 'IB DP' });
    await expect(updateProfile({ email: 'a@a.com', grade: 'Grade 7' }))
      .rejects.toMatchObject({ status: 400, message: 'IB DP is only for Grade 11–12. Please choose Grade 11 or 12, or switch to IB MYP for Grade 7.' });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('curriculum and grade changed together in one valid save is accepted', async () => {
    const updateSpy = withExisting({ role: 'student', grade: 'Grade 7', curriculum: 'IB MYP' });
    await updateProfile({ email: 'a@a.com', curriculum: 'IB DP', grade: 'Grade 11' });
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ curriculum: 'IB DP', grade: 'Grade 11' }));
  });

  test('a teacher is not limited by IB ranges', async () => {
    const updateSpy = withExisting({ role: 'teacher', grade: 'Grade 3', curriculum: 'IB DP' });
    await updateProfile({ email: 'a@a.com', grade: 'Grade 3' });
    expect(updateSpy).toHaveBeenCalled();
  });
});
