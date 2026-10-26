import express from 'express';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  return app;
}

export function requireIdentity(req, res, next) {
  const id = req.get('x-auth-user-id');
  if (!id) return res.status(401).json({ error: 'Missing gateway identity' });
  req.userId = id;
  next();
}

export function finishApp(app) {
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function jwtConfig() {
  return { secret: required('JWT_SECRET'), issuer: required('JWT_ISSUER'), audience: required('JWT_AUDIENCE') };
}
