/**
 * routes/branding.js
 * Ported from ai-mentor/server/routes/branding.js (2026-08-27) — one school
 * logo + one curriculum logo, uploaded once and reused on every worksheet
 * for that school/curriculum (not auto-detected per-PDF).
 */
const express = require('express');
const router = express.Router();
const cloudinary = require('cloudinary').v2;
const supabase = require('../services/supabase');
const { normalizeCurriculum } = require('../utils/curriculum');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── POST /branding/logo — Body: { kind, name, base64, mimeType } ───────────
router.post('/logo', async (req, res) => {
  try {
    const { kind, name: rawName, base64, mimeType = 'image/png' } = req.body || {};
    const name = kind === 'curriculum' ? normalizeCurriculum(rawName) : String(rawName || '').trim();
    if (kind !== 'school' && kind !== 'curriculum') return res.status(400).json({ error: 'kind must be "school" or "curriculum"' });
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!base64) return res.status(400).json({ error: 'base64 image required' });

    const dataUri = `data:${mimeType};base64,${base64}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'aivorah/branding',
      public_id: `${kind}_${name}`.replace(/[^a-z0-9_]/gi, '_'),
      overwrite: true,
      transformation: [{ width: 300, height: 300, crop: 'fit' }],
    });

    const logoUrl = result.secure_url;
    // One row per kind+name: drop case/whitespace variants (e.g. "Vethathiri ")
    // so an older variant can never shadow this new logo on lookup.
    const norm = s => String(s || '').trim().toLowerCase();
    const { data: existing } = await supabase.from('branding_logos').select('kind, name').in('kind', [kind]);
    const stale = (existing || []).map(r => r.name).filter(n => n !== name && norm(n) === norm(name));
    if (stale.length) await supabase.from('branding_logos').delete().eq('kind', kind).in('name', stale);

    const { error } = await supabase.from('branding_logos').upsert({
      kind, name, logo_url: logoUrl, updated_at: new Date().toISOString(),
    }, { onConflict: 'kind,name' });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ logoUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /branding/logos?school=&curriculum= ─────────────────────────────────
router.get('/logos', async (req, res) => {
  try {
    const school = String(req.query.school || '').trim();
    const curriculum = normalizeCurriculum(String(req.query.curriculum || ''));

    const names = [];
    if (school) names.push({ kind: 'school', name: school });
    if (curriculum) names.push({ kind: 'curriculum', name: curriculum });
    if (names.length === 0) return res.json({ schoolLogoUrl: null, curriculumLogoUrl: null });

    const { data } = await supabase
      .from('branding_logos')
      .select('kind, name, logo_url, updated_at')
      .in('kind', [...new Set(names.map(n => n.kind))]);

    const norm = s => String(s || '').trim().toLowerCase();
    // Newest first, so a stale case/whitespace duplicate never wins.
    data?.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const schoolLogoUrl = (data || []).find(r => r.kind === 'school' && norm(r.name) === norm(school))?.logo_url || null;
    const curriculumLogoUrl = (data || []).find(r => r.kind === 'curriculum' && norm(r.name) === norm(curriculum))?.logo_url || null;

    res.json({ schoolLogoUrl, curriculumLogoUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
