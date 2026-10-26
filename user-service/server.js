import { createUserApp } from './app.js';
import { jwtConfig, required } from '../shared/http.js';

createUserApp({
  auth: jwtConfig(),
  minio: {
    publicEndpoint: required('MINIO_PUBLIC_ENDPOINT'),
    region: process.env.MINIO_REGION || 'us-east-1',
    bucket: required('MINIO_BUCKET'),
    accessKey: required('MINIO_ACCESS_KEY'),
    secretKey: required('MINIO_SECRET_KEY'),
  },
}).listen(3001, process.env.SERVICE_HOST || '127.0.0.1', () => console.log('User Service: 3001'));
