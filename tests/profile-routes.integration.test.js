// Integration tests — hit the REAL routes (routes/profile.js) through
// Supertest, going through the full request/response cycle. Supabase,
// Cloudinary, preferences and enrollment-service are mocked.

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

const request = require('supertest');
const supabase = require('../services/supabase');
const app = require('../index');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PATCH /user/profile', () => {
  test('missing email -> 400', async () => {
    const res = await request(app).patch('/user/profile').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email required');
  });

  test('student without grade/curriculum, complete:true -> 400', async () => {
    const res = await request(app)
      .patch('/user/profile')
      .send({ email: 'a@a.com', role: 'student', complete: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/grade and curriculum/i);
  });

  test('valid update -> 200 with the saved profile', async () => {
    supabase._chain.single.mockResolvedValueOnce({
      data: { id: '1', name: 'A', email: 'a@a.com', role: 'teacher', onboarding_complete: true },
      error: null,
    });
    const res = await request(app)
      .patch('/user/profile')
      .send({ email: 'a@a.com', role: 'teacher', name: 'A', complete: true });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('A');
    expect(res.body.onboardingComplete).toBe(true);
  });

  test('user not found (empty patch, no existing row) -> 404', async () => {
    supabase._chain.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null }) // role lookup
      .mockResolvedValueOnce({ data: null, error: null }); // existing-row fetch
    const res = await request(app).patch('/user/profile').send({ email: 'nobody@a.com' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('user not found');
  });

  test('a real Supabase error -> 500', async () => {
    supabase._chain.single.mockResolvedValueOnce({ data: null, error: { code: 'OTHER', message: 'db exploded' } });
    const res = await request(app).patch('/user/profile').send({ email: 'a@a.com', role: 'teacher', name: 'A' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db exploded');
  });
});

describe('POST /user/upload-photo', () => {
  test('missing userEmail -> 400', async () => {
    const res = await request(app).post('/user/upload-photo').send({ base64: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('userEmail required');
  });

  test('missing base64 -> 400', async () => {
    const res = await request(app).post('/user/upload-photo').send({ userEmail: 'a@a.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('base64 image required');
  });

  test('successful upload -> 200 with the photo URL', async () => {
    mockCloudinaryUpload.mockResolvedValueOnce({ secure_url: 'https://cloudinary.com/a.jpg' });
    const res = await request(app)
      .post('/user/upload-photo')
      .send({ userEmail: 'a@a.com', base64: 'ZmFrZQ==' });
    expect(res.status).toBe(200);
    expect(res.body.photoUrl).toBe('https://cloudinary.com/a.jpg');
  });

  test('Cloudinary failure -> 500 (no .status on the raw error, route defaults it)', async () => {
    mockCloudinaryUpload.mockRejectedValueOnce(new Error('Cloudinary quota exceeded'));
    const res = await request(app)
      .post('/user/upload-photo')
      .send({ userEmail: 'a@a.com', base64: 'ZmFrZQ==' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Cloudinary quota exceeded');
  });
});

describe('GET /health', () => {
  test('returns ok:true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
