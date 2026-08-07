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

module.exports = router;
