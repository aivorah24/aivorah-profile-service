// Integration tests for POST /user/push-token — ported from the monolith
// (server/routes/user.js). Stores the device's Expo push token in
// user_preferences.data.expoPushTokens (deduped, capped at 10 devices).
const mockGetPreferences = jest.fn();
const mockSetPreferences = jest.fn();
jest.mock('../../services/preferences', () => ({
  getPreferences: (...args) => mockGetPreferences(...args),
  setPreferences: (...args) => mockSetPreferences(...args),
}));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  jest.clearAllMocks();
  mockSetPreferences.mockResolvedValue(undefined);
});

describe('POST /user/push-token', () => {
  test('missing email or token -> 400, never touches preferences', async () => {
    const res = await request(app).post('/user/push-token').send({ email: 'a@a.com' });
    expect(res.status).toBe(400);
    expect(mockSetPreferences).not.toHaveBeenCalled();
  });

  test('a token not shaped like an Expo push token -> 400', async () => {
    const res = await request(app).post('/user/push-token').send({ email: 'a@a.com', token: 'not-a-real-token' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid expo push token');
  });

  test('a real first registration stores the single token', async () => {
    mockGetPreferences.mockResolvedValue(null);
    const res = await request(app).post('/user/push-token').send({ email: 'a@a.com', token: 'ExponentPushToken[abc123]' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, devices: 1 });
    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({ expoPushTokens: ['ExponentPushToken[abc123]'] }));
  });

  test('registering the same token twice does not duplicate it', async () => {
    mockGetPreferences.mockResolvedValue({ expoPushTokens: ['ExponentPushToken[abc123]'] });
    const res = await request(app).post('/user/push-token').send({ email: 'a@a.com', token: 'ExponentPushToken[abc123]' });
    expect(res.body.devices).toBe(1);
  });

  test('a real second device is appended alongside the first', async () => {
    mockGetPreferences.mockResolvedValue({ expoPushTokens: ['ExponentPushToken[abc123]'] });
    const res = await request(app).post('/user/push-token').send({ email: 'a@a.com', token: 'ExponentPushToken[xyz789]' });
    expect(res.body.devices).toBe(2);
    expect(mockSetPreferences).toHaveBeenCalledWith('a@a.com', expect.objectContaining({
      expoPushTokens: ['ExponentPushToken[abc123]', 'ExponentPushToken[xyz789]'],
    }));
  });

  test('an 11th device drops the oldest, capping storage at 10', async () => {
    const existing = Array.from({ length: 10 }, (_, i) => `ExponentPushToken[dev${i}]`);
    mockGetPreferences.mockResolvedValue({ expoPushTokens: existing });
    const res = await request(app).post('/user/push-token').send({ email: 'a@a.com', token: 'ExponentPushToken[dev10]' });
    expect(res.body.devices).toBe(10);
    const saved = mockSetPreferences.mock.calls[0][1].expoPushTokens;
    expect(saved).not.toContain('ExponentPushToken[dev0]');
    expect(saved).toContain('ExponentPushToken[dev10]');
  });
});
