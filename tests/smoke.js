// Smoke test for the standalone service — proves it runs and answers
// correctly with ZERO dependency on the rest of the ai-mentor app.
//
// Run the service first (npm start), then: node tests/smoke.js

require('dotenv').config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:4002';

const DEMO_EMAILS = {
  student: process.env.DEMO_STUDENT_EMAIL || 'demo.student@aivorah.demo',
  teacher: process.env.DEMO_TEACHER_EMAIL || 'demo.teacher@aivorah.demo',
  parent:  process.env.DEMO_PARENT_EMAIL  || 'demo.parent@aivorah.demo',
};

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures++;
  }
}

async function main() {
  console.log(`Testing ${BASE_URL}\n`);

  console.log('GET /health');
  const health = await fetch(`${BASE_URL}/health`).then((r) => r.json());
  check('responds ok:true', health.ok === true);

  console.log('\nPATCH /user/profile with no email');
  const noEmailRes = await fetch(`${BASE_URL}/user/profile`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('returns 400', noEmailRes.status === 400);

  for (const [role, email] of Object.entries(DEMO_EMAILS)) {
    // Re-sends the same location value the account already has, so this is
    // safe to run repeatedly against the real demo accounts — no drift.
    console.log(`\nPATCH /user/profile for ${role} (${email})`);
    const res = await fetch(`${BASE_URL}/user/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, location: 'Hyderabad' }),
    });
    const body = await res.json();
    check('returns 200', res.status === 200);
    check('email matches', body.email === email);
  }

  console.log('\nPOST /user/upload-photo with no base64');
  const noPhotoRes = await fetch(`${BASE_URL}/user/upload-photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userEmail: DEMO_EMAILS.student }),
  });
  check('returns 400', noPhotoRes.status === 400);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
