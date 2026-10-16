const cloudinary = require('cloudinary').v2;
const supabase   = require('./supabase');
const { encrypt, decrypt } = require('../utils/encryption');
const { getPreferences, setPreferences } = require('./preferences');
const { syncEnrollmentAfterProfileUpdate } = require('./enrollment-service');
const { normalizeCurriculum, normalizeCurriculumEntries } = require('../utils/curriculum');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// The frontend has always sent/displayed dob as "DD/MM/YYYY", but `users.dob`
// is a real Postgres `date` column, which defaults to month-first parsing —
// any day > 12 fails with "date/time field value out of range", and day <= 12
// silently stores day/month swapped. user_preferences.dob (jsonb) has no such
// column type, so it's left in DD/MM/YYYY untouched; only the `users` table
// write/read needs converting. Passes through unrecognized formats unchanged.
function ddmmyyyyToIso(str) {
  if (!str) return str;
  const parts = String(str).split('/');
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts;
    if (dd && mm && yyyy && yyyy.length === 4) {
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
  }
  return str;
}

function isoToDdmmyyyy(str) {
  if (!str) return str;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : str;
}

// Updates profile fields for a logged-in user (any role), then triggers
// enrollment sync as a side effect (see enrollment-service.js).
const { curriculumGradeError } = require('../utils/curriculumGrades');

async function updateProfile({ email, name, role: bodyRole, curriculum, grade, school, location,
                                dob, gender, state, country, teaches, children, phone,
                                onboardingStep, complete, avatarStyle, learningStyle }) {
  if (!email) {
    const err = new Error('email required');
    err.status = 400;
    throw err;
  }
  curriculum = normalizeCurriculum(curriculum);
  teaches = normalizeCurriculumEntries(teaches);
  children = normalizeCurriculumEntries(children);

  let currentRole = bodyRole || null;
  let existingRow = null;
  if (!currentRole || ((grade || curriculum) && !(grade && curriculum))) {
    try {
      const { data: existing } = await supabase
        .from('users').select('role, grade, curriculum').eq('email', email.toLowerCase().trim()).maybeSingle();
      existingRow = existing || null;
      currentRole = currentRole || existing?.role || null;
    } catch (_) {}
  }

  // A student's curriculum and grade must fit together (IB DP is Grade 11–12 only, …).
  if ((grade || curriculum) && currentRole !== 'teacher' && currentRole !== 'parent') {
    const gradeError = curriculumGradeError(curriculum || existingRow?.curriculum, grade || existingRow?.grade);
    if (gradeError) {
      const err = new Error(gradeError);
      err.status = 400;
      throw err;
    }
  }

  const patch = {};
  if (name)       patch.name       = name.trim();
  if (bodyRole)   patch.role       = bodyRole;
  if (curriculum) patch.curriculum = curriculum;
  if (grade)      patch.grade      = grade.trim();

  if (complete === true) {
    const resolvedGrade      = (grade      || '').trim();
    const resolvedCurriculum = (curriculum || '').trim();
    if (currentRole === 'student' && (!resolvedGrade || !resolvedCurriculum)) {
      const err = new Error('Students must provide grade and curriculum to complete onboarding.');
      err.status = 400;
      throw err;
    }
    patch.onboarding_complete = true;
  }
  if (school)     patch.school     = school.trim();
  if (location)   patch.location   = location;
  if (phone)      patch.phone      = encrypt(phone.trim());
  if (onboardingStep != null) patch.onboarding_step = onboardingStep;
  // dob/gender/state/country: now written straight to `users` (2026-08-26) —
  // these used to only ever reach user_preferences (see preferencesPatch
  // below), which was the root cause of a bug where they'd silently vanish
  // on next login if the separate /user/preferences fetch failed for any
  // reason, while grade/curriculum/location/phone (already users-table
  // columns) never did. See docs/root-cause or the PR description.
  if (dob)     patch.dob     = ddmmyyyyToIso(String(dob));
  if (gender)  patch.gender  = String(gender);
  if (state)   patch.state   = String(state);
  if (country) patch.country = String(country);

  const emailLc = email.toLowerCase().trim();

  let data = null;
  let error = null;

  if (Object.keys(patch).length > 0) {
    ({ data, error } = await supabase
      .from('users')
      .update(patch)
      .eq('email', emailLc)
      .select('id, name, email, role, grade, school, curriculum, location, phone, onboarding_complete, dob, gender, state, country')
      .single());

    if (error && error.code === 'PGRST116') {
      ({ data, error } = await supabase
        .from('users')
        .upsert({ email: emailLc, ...patch }, { onConflict: 'email' })
        .select('id, name, email, role, grade, school, curriculum, location, phone, onboarding_complete, dob, gender, state, country')
        .single());
    }

    if (error) {
      const err = new Error(error.message);
      err.status = 500;
      throw err;
    }
  } else {
    const { data: existing } = await supabase
      .from('users')
      .select('id, name, email, role, grade, school, curriculum, location, phone, onboarding_complete, dob, gender, state, country')
      .eq('email', emailLc)
      .maybeSingle();
    data = existing;
  }

  if (!data) {
    const err = new Error('user not found');
    err.status = 404;
    throw err;
  }

  // Collapsed into one setPreferences call (was 3 separate read-merge-upsert
  // round-trips) — teaches/children/dob/gender/phone can all arrive on the
  // same request, so writing them together avoids the last call clobbering
  // an in-flight merge from an earlier one.
  const preferencesPatch = {};
  if (teaches && Array.isArray(teaches))   preferencesPatch.teaches  = teaches;
  if (children && Array.isArray(children)) preferencesPatch.children = children;
  if (dob)    preferencesPatch.dob    = dob;
  if (gender) preferencesPatch.gender = gender;
  if (phone)  preferencesPatch.phone  = encrypt(phone);
  if (avatarStyle)   preferencesPatch.avatarStyle   = String(avatarStyle);
  if (learningStyle) preferencesPatch.learningStyle = String(learningStyle);
  if (Object.keys(preferencesPatch).length > 0) {
    preferencesPatch.updatedAt = new Date().toISOString();
    await setPreferences(email, preferencesPatch);
  }

  await syncEnrollmentAfterProfileUpdate({
    role: data.role,
    userId: data.id,
    curriculum: normalizeCurriculum(data.curriculum),
    grade: data.grade,
    teaches,
  });

  return {
    id:                 data.id,
    name:               data.name,
    email:              data.email,
    role:               data.role,
    grade:              data.grade,
    school:             data.school,
    curriculum:         normalizeCurriculum(data.curriculum),
    location:           data.location,
    phone:              data.phone ? decrypt(data.phone) : null,
    onboardingComplete: data.onboarding_complete,
    dob:                isoToDdmmyyyy(data.dob) || null,
    gender:             data.gender  || null,
    state:              data.state   || null,
    country:            data.country || null,
  };
}

// Uploads a profile photo to Cloudinary (face-cropped 400x400) and saves URL.
async function uploadProfilePhoto({ userEmail, base64, mimeType = 'image/jpeg' }) {
  if (!userEmail) {
    const err = new Error('userEmail required');
    err.status = 400;
    throw err;
  }
  if (!base64) {
    const err = new Error('base64 image required');
    err.status = 400;
    throw err;
  }

  const dataUri = `data:${mimeType};base64,${base64}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder:         'aivorah/profiles',
    public_id:      userEmail.replace(/[@.]/g, '_'),
    overwrite:      true,
    transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }],
  });

  const photoUrl = result.secure_url;
  await supabase.from('users').update({ photo_url: photoUrl }).eq('email', userEmail.toLowerCase().trim());

  return { photoUrl };
}

// Ported from ai-mentor/server/routes/user.js PATCH /user/preferences — same
// user_preferences jsonb patch, same users-table write-through for the fields
// that must survive re-login (grade/curriculum/location/phone), same shared
// Supabase project, so this is byte-compatible with rows the monolith wrote.
async function updatePreferences(body) {
  const {
    email, name, role, grade, curriculum, school, location,
    avatarStyle, learningStyle, interests, bio, photoUrl,
    pushNotifications, aiSuggestions, weeklyReport, assignmentAlerts, challengeUpdates,
    autoGrading, shareProgress,
    gender, dob, mobile, phone, mobileVerified, state, country,
    teacherRole, experience, roles, activeRole, mustChangePassword,
  } = body ?? {};

  if (!email) {
    const err = new Error('email required');
    err.status = 400;
    throw err;
  }

  const patch = {};
  if (name != null) patch.name = String(name);
  if (role != null) patch.role = String(role);
  if (grade != null) patch.grade = String(grade);
  if (curriculum != null) patch.curriculum = normalizeCurriculum(curriculum);
  if (school != null) patch.school = String(school);
  if (location != null) patch.location = String(location);
  if (avatarStyle != null) patch.avatarStyle = String(avatarStyle);
  if (learningStyle != null) patch.learningStyle = String(learningStyle);
  if (bio != null) patch.bio = String(bio);
  // Explicit `photoUrl: null` = clear the photo (built-in avatar picked); an absent key leaves it untouched.
  const hasPhotoUrl = Object.prototype.hasOwnProperty.call(body ?? {}, 'photoUrl');
  if (hasPhotoUrl) patch.photoUrl = photoUrl != null ? String(photoUrl) : null;
  if (interests != null) {
    patch.interests = Array.isArray(interests)
      ? interests.map((x) => String(x))
      : String(interests).split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (pushNotifications != null) patch.pushNotifications = Boolean(pushNotifications);
  if (aiSuggestions != null) patch.aiSuggestions = Boolean(aiSuggestions);
  if (weeklyReport != null) patch.weeklyReport = Boolean(weeklyReport);
  if (assignmentAlerts != null) patch.assignmentAlerts = Boolean(assignmentAlerts);
  if (challengeUpdates != null) patch.challengeUpdates = Boolean(challengeUpdates);
  if (autoGrading != null) patch.autoGrading = Boolean(autoGrading);
  if (shareProgress != null) patch.shareProgress = Boolean(shareProgress);
  if (gender != null) patch.gender = String(gender);
  if (dob != null) patch.dob = String(dob);
  if (state != null) patch.state = String(state);
  if (country != null) patch.country = String(country);
  if (teacherRole != null) patch.teacherRole = String(teacherRole);
  if (experience != null) patch.experience = String(experience);
  const phoneVal = phone ?? mobile;
  if (phoneVal != null) patch.phone = encrypt(String(phoneVal));
  if (mobileVerified != null) patch.mobileVerified = Boolean(mobileVerified);
  if (Array.isArray(roles) && roles.length > 0) patch.roles = roles;
  if (activeRole != null) patch.activeRole = String(activeRole);
  // Ported so SetPasswordScreen.tsx can clear this flag via THIS service
  // instead of the monolith's now-unreachable-in-practice
  // /user/clear-must-change-password (see that screen's fetch call for the
  // full bug - the monolith writes to a different Supabase project than
  // this service, so that call never actually cleared the flag anywhere
  // /user/sync reads from, sending the student back to Set Password on
  // every subsequent fresh login even after they'd already set one).
  if (mustChangePassword != null) patch.mustChangePassword = Boolean(mustChangePassword);

  patch.updatedAt = new Date().toISOString();
  await setPreferences(email, patch);

  // Same write-through as updateProfile() above — keeps grade/curriculum/
  // location/phone readable from `users` on next login without a preferences join.
  // gender/dob/state/country added 2026-08-26 for the same reason — they used
  // to live ONLY in user_preferences, so a single failed/slow GET
  // /user/preferences at login silently dropped them while everything else
  // (already users-table columns) survived. Root cause of the "Gender/DOB/
  // State missing on re-login" bug.
  const usersPatch = {};
  if (grade != null) usersPatch.grade = String(grade);
  if (curriculum != null) usersPatch.curriculum = normalizeCurriculum(curriculum);
  if (location != null) usersPatch.location = String(location);
  if (phoneVal != null) usersPatch.phone = encrypt(String(phoneVal));
  if (gender != null) usersPatch.gender = String(gender);
  if (dob != null) usersPatch.dob = ddmmyyyyToIso(String(dob));
  if (state != null) usersPatch.state = String(state);
  if (country != null) usersPatch.country = String(country);
  if (hasPhotoUrl) usersPatch.photo_url = photoUrl != null ? String(photoUrl) : null;
  if (Object.keys(usersPatch).length > 0) {
    await supabase.from('users').update(usersPatch).eq('email', email.toLowerCase().trim());
  }

  const saved = await getPreferences(email);
  if (saved?.phone) saved.phone = decrypt(saved.phone);
  return normalizePrefsCurricula(saved);
}

// Legacy preference blobs can still say "NCERT" — never hand that back to the app.
function normalizePrefsCurricula(rec) {
  if (!rec) return rec;
  if (rec.curriculum != null) rec.curriculum = normalizeCurriculum(rec.curriculum);
  if (rec.teaches) rec.teaches = normalizeCurriculumEntries(rec.teaches);
  if (rec.children) rec.children = normalizeCurriculumEntries(rec.children);
  return rec;
}

async function fetchPreferences(email) {
  if (!email) return null; // don't expose all records, same guard as the monolith
  const rec = await getPreferences(email);
  if (rec?.phone) rec.phone = decrypt(rec.phone);
  return normalizePrefsCurricula(rec) ?? null;
}

module.exports = { updateProfile, uploadProfilePhoto, updatePreferences, fetchPreferences };
