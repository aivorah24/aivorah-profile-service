const mockUpdateProfile = jest.fn();
const mockUploadProfilePhoto = jest.fn();
jest.mock('../../services/profile-service', () => ({
  updateProfile: (...args) => mockUpdateProfile(...args),
  uploadProfilePhoto: (...args) => mockUploadProfilePhoto(...args),
}));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /health', () => {
  test('returns a real ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'aivorah-profile-service' });
  });
});

describe('PATCH /user/profile', () => {
  test('a real successful update returns the real service result', async () => {
    mockUpdateProfile.mockResolvedValue({ id: 'u1', email: 'a@a.com', name: 'New Name' });

    const res = await request(app).patch('/user/profile').send({ email: 'a@a.com', name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', email: 'a@a.com', name: 'New Name' });
    expect(mockUpdateProfile).toHaveBeenCalledWith({ email: 'a@a.com', name: 'New Name' });
  });

  test('a real missing-email validation error from the service surfaces as a real 400', async () => {
    const err = new Error('email required');
    err.status = 400;
    mockUpdateProfile.mockRejectedValue(err);

    const res = await request(app).patch('/user/profile').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('email required');
  });

  test('a real not-found error from the service surfaces as a real 404', async () => {
    const err = new Error('user not found');
    err.status = 404;
    mockUpdateProfile.mockRejectedValue(err);

    const res = await request(app).patch('/user/profile').send({ email: 'ghost@a.com', name: 'X' });

    expect(res.status).toBe(404);
  });

  test('a real unexpected db error surfaces as a real 500', async () => {
    mockUpdateProfile.mockRejectedValue(new Error('db exploded'));

    const res = await request(app).patch('/user/profile').send({ email: 'a@a.com', name: 'X' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db exploded');
  });

  test('a real empty body is still forwarded to the service (which owns validation)', async () => {
    mockUpdateProfile.mockResolvedValue({ id: 'u1' });

    await request(app).patch('/user/profile').send();

    expect(mockUpdateProfile).toHaveBeenCalledWith({});
  });

  // Regression test for the "Gender/DOB/State missing on re-login" bug
  // (2026-08-26) — dob/gender/state/country now round-trip through this
  // route the same as any other profile field.
  test('a real dob/gender/state/country round-trip through this route to the service and back', async () => {
    mockUpdateProfile.mockResolvedValue({ id: 'u1', email: 'a@a.com', dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' });

    const res = await request(app).patch('/user/profile').send({ email: 'a@a.com', dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' });
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@a.com', dob: '15/06/2012', gender: 'Female', state: 'Karnataka', country: 'India' })
    );
  });
});

describe('POST /user/upload-photo', () => {
  test('a real successful upload returns the real photoUrl', async () => {
    mockUploadProfilePhoto.mockResolvedValue({ photoUrl: 'https://cdn/a.png' });

    const res = await request(app).post('/user/upload-photo').send({ userEmail: 'a@a.com', base64: 'abc123' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ photoUrl: 'https://cdn/a.png' });
  });

  test('a real missing base64 validation error surfaces as a real 400', async () => {
    const err = new Error('base64 image required');
    err.status = 400;
    mockUploadProfilePhoto.mockRejectedValue(err);

    const res = await request(app).post('/user/upload-photo').send({ userEmail: 'a@a.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('base64 image required');
  });

  test('a real Cloudinary failure surfaces as a real 500', async () => {
    mockUploadProfilePhoto.mockRejectedValue(new Error('Cloudinary is down'));

    const res = await request(app).post('/user/upload-photo').send({ userEmail: 'a@a.com', base64: 'abc123' });

    expect(res.status).toBe(500);
  });
});
