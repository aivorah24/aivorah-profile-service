const express = require('express');
const router  = express.Router();
const profileService = require('../services/profile-service');

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

module.exports = router;
