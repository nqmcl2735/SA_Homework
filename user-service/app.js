import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createApp, finishApp, requireIdentity } from '../shared/http.js';

const salt = 'sa-homework-demo';
const passwordHash = scryptSync('123456', salt, 64);
const users = [
  { id: '1', name: 'Nguyen Van A', email: 'user@example.com', avatarUrl: null },
  { id: '2', name: 'Tran Thi B', email: 'user2@example.com', avatarUrl: null },
];
const imageTypes = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function createUserApp({ auth, minio }) {
  const app = createApp();
  const s3 = new S3Client({
    endpoint: minio.publicEndpoint,
    region: minio.region,
    credentials: { accessKeyId: minio.accessKey, secretAccessKey: minio.secretKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'users' }));
  app.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const user = users.find((item) => item.email === email);
    const validPassword = timingSafeEqual(passwordHash, scryptSync(password, salt, 64));
    if (!user || !validPassword) return res.status(401).json({ error: 'Invalid credentials' });
    const accessToken = jwt.sign({}, auth.secret, {
      algorithm: 'HS256', subject: user.id, issuer: auth.issuer, audience: auth.audience, expiresIn: '15m',
    });
    res.json({ accessToken });
  });
  app.use('/users', requireIdentity);
  function ownUser(req, res, next) {
    if (req.params.id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    req.user = users.find((user) => user.id === req.params.id);
    if (!req.user) return res.status(404).json({ error: 'User not found' });
    next();
  }
  app.get('/users/:id', ownUser, (req, res) => res.json(req.user));
  app.post('/users/:id/avatar-upload-url', ownUser, async (req, res) => {
    const contentType = req.body?.contentType;
    if (typeof contentType !== 'string' || !Object.hasOwn(imageTypes, contentType)) {
      return res.status(400).json({ error: 'contentType must be image/png, image/jpeg or image/webp' });
    }
    const command = new PutObjectCommand({
      Bucket: minio.bucket,
      Key: `avatars/${req.user.id}/${randomUUID()}.${imageTypes[contentType]}`,
      ContentType: contentType,
    });
    const uploadUrl = await getSignedUrl(s3, command, {
      expiresIn: 300,
      signableHeaders: new Set(['content-type']),
    });
    res.json({ uploadUrl, method: 'PUT', expiresIn: 300, contentType });
  });
  return finishApp(app);
}
