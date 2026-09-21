const express = require('express');
const router  = express.Router();
const profileService = require('../services/profile-service');
const supabase = require('../services/supabase');
const { getPreferences, setPreferences } = require('../services/preferences');

router.patch('/profile', async (req, res) => {
  try {
    const result = await profileService.updateProfile(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/upload-photo', async (req, res) => {
  try {
    const result = await profileService.uploadProfilePhoto(req.body ?? {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── /user/preferences — ported from the monolith (server/routes/user.js) ──
// Same user_preferences table, same Supabase project, so existing rows the
// monolith wrote (including encrypted phone) read/write identically here.
router.patch('/preferences', async (req, res) => {
  try {
    const preference = await profileService.updatePreferences(req.body ?? {});
    res.json({ ok: true, preference });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/preferences', async (req, res) => {
  try {
    const email = req.query.email ? String(req.query.email).toLowerCase().trim() : '';
    const rec = await profileService.fetchPreferences(email);
    res.json(rec);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── PATCH /user/add-role — ported from the monolith (server/routes/user.js) ──
// Adds a role to the account's roles list (stored in user_preferences.data.roles,
// merged with the primary `users.role` — the primary role is always ground
// truth). Used by the teacher "Add a parent profile" flow.
router.patch('/add-role', async (req, res) => {
  const { email, role } = req.body ?? {};
  if (!email || !role) return res.status(400).json({ error: 'email and role required' });

  const allowed = ['teacher', 'parent', 'student'];
  if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const emailLc = String(email).toLowerCase().trim();

  const { data: user, error: fetchErr } = await supabase
    .from('users').select('id, role').eq('email', emailLc).maybeSingle();
  if (fetchErr || !user) return res.status(404).json({ error: 'User not found' });

  const existingPrefs = await getPreferences(emailLc);
  const primaryRole = user.role;
  const prefsRoles = Array.isArray(existingPrefs?.roles) ? existingPrefs.roles : [];
  const merged = Array.from(new Set([primaryRole, ...prefsRoles, role]));

  await setPreferences(emailLc, { ...existingPrefs, roles: merged });

  res.json({ ok: true, roles: merged });
});

// ── POST /user/push-token — ported from the monolith (server/routes/user.js) ──
// Mobile app registers its Expo push token here so the server can notify this
// user. Tokens are kept in user_preferences.data.expoPushTokens (deduped array).
router.post('/push-token', async (req, res) => {
  try {
    const { email, token } = req.body ?? {};
    if (!email || !token) return res.status(400).json({ error: 'email and token required' });
    if (!String(token).startsWith('ExponentPushToken')) {
      return res.status(400).json({ error: 'invalid expo push token' });
    }
    const existing = await getPreferences(email);
    const current = Array.isArray(existing?.expoPushTokens) ? existing.expoPushTokens : [];
    const merged = [...new Set([...current, String(token)])].slice(-10); // cap stored devices
    await setPreferences(email, { expoPushTokens: merged, updatedAt: new Date().toISOString() });
    res.json({ ok: true, devices: merged.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
