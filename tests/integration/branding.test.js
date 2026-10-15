// Integration tests for POST /branding/logo and GET /branding/logos —
// ported from the monolith (ai-mentor/server/routes/branding.js) 2026-08-27.
const mockCloudinaryUpload = jest.fn();
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: { upload: (...args) => mockCloudinaryUpload(...args) },
  },
}));

const mockUpsert = jest.fn();
const mockLogosSelectIn = jest.fn();
const mockDeleteIn = jest.fn();
jest.mock('../../services/supabase', () => ({
  from: jest.fn((table) => {
    if (table === 'branding_logos') {
      return {
        upsert: (...args) => mockUpsert(...args),
        select: () => ({ in: (...args) => mockLogosSelectIn(...args) }),
        delete: () => ({ eq: () => ({ in: (...args) => mockDeleteIn(...args) }) }),
      };
    }
    return {};
  }),
}));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({ error: null });
  mockLogosSelectIn.mockResolvedValue({ data: [] });
  mockDeleteIn.mockResolvedValue({ error: null });
});

describe('branding logos — duplicate name variants', () => {
  test('upload trims the name and deletes case/whitespace variants', async () => {
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://cdn/new.png' });
    mockLogosSelectIn.mockResolvedValue({ data: [{ kind: 'school', name: 'vethathiri ' }, { kind: 'school', name: 'Vethathiri' }, { kind: 'school', name: 'Other' }] });
    const res = await request(app).post('/branding/logo').send({ kind: 'school', name: 'Vethathiri ', base64: 'abc' });
    expect(res.status).toBe(200);
    expect(mockDeleteIn).toHaveBeenCalledWith('name', ['vethathiri ']);
    expect(mockUpsert.mock.calls[0][0]).toMatchObject({ kind: 'school', name: 'Vethathiri', logo_url: 'https://cdn/new.png' });
  });

  test('lookup returns the newest of duplicate variants', async () => {
    mockLogosSelectIn.mockResolvedValue({ data: [
      { kind: 'school', name: 'Vethathiri', logo_url: 'https://cdn/old.png', updated_at: '2026-09-16T00:00:00Z' },
      { kind: 'school', name: 'Vethathiri ', logo_url: 'https://cdn/new.png', updated_at: '2026-10-15T00:00:00Z' },
    ] });
    const res = await request(app).get('/branding/logos?school=Vethathiri');
    expect(res.body.schoolLogoUrl).toBe('https://cdn/new.png');
  });
});

describe('POST /branding/logo', () => {
  test('an invalid kind -> 400, never uploads', async () => {
    const res = await request(app).post('/branding/logo').send({ kind: 'other', name: 'X', base64: 'abc' });
    expect(res.status).toBe(400);
    expect(mockCloudinaryUpload).not.toHaveBeenCalled();
  });

  test('missing name -> 400', async () => {
    const res = await request(app).post('/branding/logo').send({ kind: 'school', base64: 'abc' });
    expect(res.status).toBe(400);
  });

  test('missing base64 -> 400', async () => {
    const res = await request(app).post('/branding/logo').send({ kind: 'school', name: 'Riverdale High' });
    expect(res.status).toBe(400);
  });

  test('a real successful upload saves the real Cloudinary URL and returns it', async () => {
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://cdn.cloudinary.com/school_riverdale.png' });
    const res = await request(app).post('/branding/logo').send({ kind: 'school', name: 'Riverdale High', base64: 'abc123', mimeType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ logoUrl: 'https://cdn.cloudinary.com/school_riverdale.png' });
    expect(mockCloudinaryUpload).toHaveBeenCalledWith(
      'data:image/png;base64,abc123',
      expect.objectContaining({ public_id: 'school_Riverdale_High' }),
    );
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'school', name: 'Riverdale High', logo_url: 'https://cdn.cloudinary.com/school_riverdale.png' }),
      { onConflict: 'kind,name' },
    );
  });

  test('a real Supabase write failure surfaces as a real 500', async () => {
    mockCloudinaryUpload.mockResolvedValue({ secure_url: 'https://cdn/x.png' });
    mockUpsert.mockResolvedValue({ error: { message: 'db down' } });
    const res = await request(app).post('/branding/logo').send({ kind: 'school', name: 'X', base64: 'abc' });
    expect(res.status).toBe(500);
  });
});

describe('GET /branding/logos', () => {
  test('no real school or curriculum query params -> both null, no Supabase call', async () => {
    const res = await request(app).get('/branding/logos');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schoolLogoUrl: null, curriculumLogoUrl: null });
    expect(mockLogosSelectIn).not.toHaveBeenCalled();
  });

  test('a real school+curriculum match returns both real logo URLs', async () => {
    mockLogosSelectIn.mockResolvedValue({
      data: [
        { kind: 'school', name: 'Riverdale High', logo_url: 'https://cdn/school.png' },
        { kind: 'curriculum', name: 'IB PYP', logo_url: 'https://cdn/curriculum.png' },
      ],
    });
    const res = await request(app).get('/branding/logos').query({ school: 'Riverdale High', curriculum: 'IB PYP' });
    expect(res.body).toEqual({ schoolLogoUrl: 'https://cdn/school.png', curriculumLogoUrl: 'https://cdn/curriculum.png' });
  });

  test('a real case/whitespace mismatch still resolves the logo', async () => {
    mockLogosSelectIn.mockResolvedValue({
      data: [{ kind: 'school', name: '  riverdale high  ', logo_url: 'https://cdn/school.png' }],
    });
    const res = await request(app).get('/branding/logos').query({ school: 'Riverdale High' });
    expect(res.body.schoolLogoUrl).toBe('https://cdn/school.png');
  });

  test('no real matching row for the given name -> null for that logo', async () => {
    mockLogosSelectIn.mockResolvedValue({ data: [{ kind: 'school', name: 'Some Other School', logo_url: 'https://cdn/other.png' }] });
    const res = await request(app).get('/branding/logos').query({ school: 'Riverdale High' });
    expect(res.body.schoolLogoUrl).toBeNull();
  });
});
