/**
 * routes/parent.js
 * Ported from ai-mentor/server/routes/parent.js (2026-08-27) — ONLY the two
 * routes the teacher "Add a parent profile" flow actually calls
 * (create-student, link-by-email). The monolith's parent.js has ~15 routes
 * total (screen-time, AI reports, credential resets, init-auth, etc.) that
 * belong to the separate parent-persona feature set, not this scope — those
 * stay in the monolith pending their own dedicated extraction.
 */
const express = require('express');
const router = express.Router();
const { randomInt } = require('crypto');
const supabase = require('../services/supabase');
const { sendCredentialsEmail } = require('../services/mailer');
const { normalizeCurriculum } = require('../utils/curriculum');

function toTitleCase(str) {
  return String(str || '').replace(/\b\w/g, c => c.toUpperCase());
}

function generateSecureChildPassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '#@$%&*?',
  ];
  const all = groups.join('');
  const chars = groups.map((group) => group[randomInt(group.length)]);
  while (chars.length < 12) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function generateChildLoginId(parentEmail) {
  if (parentEmail) {
    const localPart = parentEmail.split('@')[0].toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    for (let n = 1; n < 100; n++) {
      const candidate = `${localPart}_ch${n}@aivorah.student`;
      const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
      if (!existing) return candidate;
    }
  }
  for (let n = 1; n < 100000; n++) {
    const candidate = `ch${n}@aivorah.student`;
    const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `ch${Date.now()}@aivorah.student`;
}

async function setStudentMeta(email, studentId, parentEmail, firebaseUid, status = 'active') {
  const emailKey = String(email || '').toLowerCase().trim();
  if (!emailKey) return;
  const { data: existing } = await supabase
    .from('user_preferences').select('data').eq('user_email', emailKey).maybeSingle();
  const merged = {
    ...(existing?.data || {}),
    studentId,
    createdByParent: String(parentEmail || '').toLowerCase().trim(),
    firebaseUid: String(firebaseUid || '').trim() || undefined,
    accountStatus: status,
    emailVerificationRequired: status === 'pending_verification',
    activatedAt: status === 'active' ? (existing?.data?.activatedAt || new Date().toISOString()) : existing?.data?.activatedAt,
    updatedAt: new Date().toISOString(),
  };
  await supabase.from('user_preferences').upsert(
    { user_email: emailKey, data: merged, updated_at: new Date().toISOString() },
    { onConflict: 'user_email' },
  );
}

// ── POST /parent/:parentEmail/children/create-student ──────────────────────
router.post('/:parentEmail/children/create-student', async (req, res) => {
  try {
    const { parentEmail } = req.params;
    const { name, email, password, grade, curriculum, school = '', studentId } = req.body || {};

    if (!name || !grade || !curriculum) {
      return res.status(400).json({ error: 'name, grade and curriculum are required' });
    }

    const emailProvided = Boolean(email && String(email).trim());
    const cleanEmail = emailProvided
      ? String(email).trim().toLowerCase()
      : await generateChildLoginId(parentEmail);
    const resolvedStudentId = String(studentId || '').trim() || `STU-${Date.now()}`;
    const hasPasswordInput = Boolean(password && String(password).trim());
    const cleanPassword = hasPasswordInput ? String(password).trim() : generateSecureChildPassword();

    const { data: existing } = await supabase
      .from('users').select('id').eq('email', cleanEmail).maybeSingle();
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists. Use "Link Existing" instead.' });
    }

    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: cleanEmail,
      password: cleanPassword,
      email_confirm: !emailProvided,
    });
    if (authErr || !authData?.user) {
      return res.status(500).json({ error: authErr?.message || 'Could not create auth account' });
    }
    const userId = authData.user.id;

    const { error: insertErr } = await supabase.from('users').insert({
      id: userId,
      name: toTitleCase(String(name).trim()),
      email: cleanEmail,
      role: 'student',
      grade,
      curriculum: normalizeCurriculum(curriculum),
      school: String(school).trim(),
      onboarding_complete: true,
      created_at: new Date().toISOString(),
    });
    if (insertErr) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: insertErr.message });
    }

    const { error: linkErr } = await supabase
      .from('parent_children').insert({ parent_email: parentEmail, child_id: userId });
    if (linkErr && linkErr.code !== '23505') {
      return res.status(500).json({ error: linkErr.message });
    }

    await supabase.from('student_stats')
      .upsert({ student_id: userId }, { onConflict: 'student_id', ignoreDuplicates: true });
    await setStudentMeta(cleanEmail, resolvedStudentId, parentEmail, undefined, 'active');

    if (emailProvided) {
      sendCredentialsEmail({
        to: cleanEmail,
        childName: String(name).trim(),
        loginId: cleanEmail,
        password: !hasPasswordInput ? cleanPassword : undefined,
        studentId: resolvedStudentId,
      }).catch(() => {});
    }

    res.json({
      success: true,
      child: {
        id: userId, studentId: resolvedStudentId, name: String(name).trim(), email: cleanEmail, grade, curriculum, school,
        generatedPassword: !hasPasswordInput ? cleanPassword : undefined,
        onboardingComplete: true,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /parent/:parentEmail/children — link an existing student by email ──
router.post('/:parentEmail/children', async (req, res) => {
  try {
    const { parentEmail } = req.params;
    const { childEmail } = req.body || {};
    if (!childEmail) return res.status(400).json({ error: 'childEmail required' });

    const { data: child, error: lookupErr } = await supabase
      .from('users')
      .select('id, name, email, grade, school')
      .eq('email', String(childEmail).toLowerCase().trim())
      .single();
    if (lookupErr || !child) {
      return res.status(404).json({ error: 'No student found with that email. Ask your child to register first.' });
    }

    const { error: linkErr } = await supabase
      .from('parent_children').insert({ parent_email: parentEmail, child_id: child.id });
    if (linkErr) {
      if (linkErr.code === '23505') return res.status(409).json({ error: 'This child is already linked to your account.' });
      return res.status(500).json({ error: linkErr.message });
    }

    res.json({ success: true, child: { id: child.id, name: child.name, email: child.email, grade: child.grade, school: child.school } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
