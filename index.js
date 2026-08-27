// Standalone profile microservice — extracted from ai-mentor/server/routes/user.js.
// Serves PATCH /user/profile and POST /user/upload-photo on its own port.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const profileRoute = require('./routes/profile');
const parentRoute = require('./routes/parent');
const brandingRoute = require('./routes/branding');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // photo uploads are base64

app.use('/user', profileRoute);
app.use('/parent', parentRoute);
app.use('/branding', brandingRoute);

app.get('/health', (req, res) => res.json({ ok: true, service: 'aivorah-profile-service' }));

const PORT = process.env.PORT || 4002;
if (require.main === module) {
  app.listen(PORT, () => console.log(`[aivorah-profile-service] listening on port ${PORT}`));
}

module.exports = app;
