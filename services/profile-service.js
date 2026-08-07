const cloudinary = require('cloudinary').v2;
const supabase   = require('./supabase');
const { encrypt, decrypt } = require('../utils/encryption');
const { setPreferences } = require('./preferences');
const { syncEnrollmentAfterProfileUpdate } = require('./enrollment-service');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Updates profile fields for a logged-in user (any role), then triggers
// enrollment sync as a side effect (see enrollment-service.js).
async function updateProfile({ email, name, role: bodyRole, curriculum, grade, school, location,
                                dob, gender, teaches, children, phone,
                                onboardingStep, complete }) {
  if (!email) {
    const err = new Error('email required');
    err.status = 400;
    throw err;
  }

  let currentRole = bodyRole || null;
  if (!currentRole) {
    try {
      const { data: existing } = await supabase
        .from('users').select('role').eq('email', email.toLowerCase().trim()).maybeSingle();
      currentRole = existing?.role ?? null;
    } catch (_) {}
  }

  const patch = {};
  if (name)       patch.name       = name.trim();
  if (bodyRole)   patch.role       = bodyRole;
  if (curriculum) patch.curriculum = curriculum.trim();
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

  const emailLc = email.toLowerCase().trim();

  let data = null;
  let error = null;

  if (Object.keys(patch).length > 0) {
    ({ data, error } = await supabase
      .from('users')
      .update(patch)
      .eq('email', emailLc)
      .select('id, name, email, role, grade, school, curriculum, location, phone, onboarding_complete')
      .single());

    if (error && error.code === 'PGRST116') {
      ({ data, error } = await supabase
        .from('users')
        .upsert({ email: emailLc, ...patch }, { onConflict: 'email' })
        .select('id, name, email, role, grade, school, curriculum, location, phone, onboarding_complete')
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
      .select('id, name, email, role, grade, school, curriculum, location, phone, onboarding_complete')
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
  if (Object.keys(preferencesPatch).length > 0) {
    preferencesPatch.updatedAt = new Date().toISOString();
    await setPreferences(email, preferencesPatch);
  }

  await syncEnrollmentAfterProfileUpdate({
    role: data.role,
    userId: data.id,
    curriculum: data.curriculum,
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
    curriculum:         data.curriculum,
    location:           data.location,
    phone:              data.phone ? decrypt(data.phone) : null,
    onboardingComplete: data.onboarding_complete,
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

module.exports = { updateProfile, uploadProfilePhoto };
