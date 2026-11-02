# aivorah-profile-service

User profile and preferences: edit profile, photo upload, learning preferences, add a role, push token; parent creates/links a child; school branding logos. Extracted from the `ai-mentor` monolith.

**Called by:** frontend onboarding, Settings / My Profile, parent My Kids, and header branding.

## Endpoints
| Route | What it does |
|---|---|
| `PATCH /user/profile` | Update profile fields |
| `POST /user/upload-photo` | Upload profile photo (base64 to Cloudinary) |
| `GET/PATCH /user/preferences` | Learning preferences |
| `PATCH /user/add-role` | Add a persona to an account |
| `POST /user/push-token` | Save the Expo push token |
| `POST /parent/:parentEmail/children, /children/create-student` | Link or create a child |
| `POST /branding/logo, GET /branding/logos` | School / curriculum logos |
| `GET /health` | Health check |

## Run locally
```bash
npm ci
cp .env.example .env   # fill in values; see table below
npm run dev            # nodemon, port 4002
```

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `4002`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project and service-role key (server-only, never expose) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | File/image uploads |
| `RESEND_API_KEY` / `EMAIL_USER`, `EMAIL_PASS` | Outgoing email: Resend, or Gmail SMTP as fallback |
| `ENCRYPTION_KEY` | Encrypts stored sensitive fields (`utils/encryption.js`). Must stay the same across deploys |
| `CONTACT_INBOX` | Where contact-form emails go |
| `DEMO_*_EMAIL`, `BASE_URL` | Only for `npm run test:smoke` |

## Tests
```bash
npm test
```

## Deploy
- **Render** web service `aivorah-profile-service` → https://aivorah-profile-service.onrender.com
- Auto-deploys from `main`. Build `npm install`, start `npm start`.
- CI: `.circleci/config.yml` and `.github/workflows/ci.yml` run the tests (GitHub Actions is billing-blocked on the account)
- After a merge, check the live commit on Render matches the branch head.

## Auth
No token check yet: trusts the email in the request. See the auth audit in `aivorah-handover`.

## Folder layout
| Path | Why it exists |
|---|---|
| `index.js` | Express app: middleware, route mounting, `/health`, listen |
| `routes/` | `profile.js`, `parent.js`, `branding.js` |
| `services/` | Profile, preferences, enrollment (child create/link), mailer, Supabase client |
| `utils/` | Curriculum/grade helpers, field encryption |
| `tests/` | Jest tests + smoke script |

See [CONTRIBUTING.md](CONTRIBUTING.md) for PR rules.
