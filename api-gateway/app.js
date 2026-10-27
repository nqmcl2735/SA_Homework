import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { createApp, finishApp } from '../shared/http.js';

export function createGatewayApp({ auth, userServiceUrl, orderServiceUrl }) {
  const app = createApp();
  const limiter = () => rateLimit({
    windowMs: 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many requests' },
  });
  const protectedLimiter = limiter();
  function authenticate(req, res, next) {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '');
    if (!match) return res.status(401).json({ error: 'Invalid or missing access token' });
    try {
      const payload = jwt.verify(match[1], auth.secret, {
        algorithms: ['HS256'], issuer: auth.issuer, audience: auth.audience,
      });
      if (typeof payload.sub !== 'string' || !payload.sub.trim() || !Number.isFinite(payload.exp)) throw new Error('Missing claims');
      req.userId = payload.sub;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired access token' });
    }
  }
  async function upstream(base, path, req) {
    // Only forward explicitly trusted headers; never accept client identity headers.
    const headers = { 'content-type': 'application/json' };
    if (req.userId) headers['x-auth-user-id'] = req.userId;
    return fetch(`${base}${path}`, {
      method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(5000),
      ...(!['GET', 'HEAD'].includes(req.method) && req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
  }
  function proxy(base) {
    return async (req, res) => {
      try {
        const response = await upstream(base, req.originalUrl, req);
        const body = await response.text();
        res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(body);
      } catch {
        res.status(502).json({ error: 'Upstream service unavailable' });
      }
    };
  }
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'api-gateway' }));
  app.post('/login', limiter(), proxy(userServiceUrl));
  app.use('/users', protectedLimiter, authenticate, proxy(userServiceUrl));
  app.use('/orders', protectedLimiter, authenticate, proxy(orderServiceUrl));
  app.get('/dashboard', protectedLimiter, authenticate, async (req, res) => {
    const id = encodeURIComponent(req.userId);
    async function readService(base, path) {
      const response = await upstream(base, path, req);
      const data = await response.json();
      if (!response.ok) throw new Error('Upstream service unavailable');
      return data;
    }
    const [userResult, ordersResult] = await Promise.allSettled([
      readService(userServiceUrl, `/users/${id}`).then((user) => {
        if (!user || user.id !== req.userId) throw new Error('Invalid user response');
        return user;
      }),
      readService(orderServiceUrl, `/orders?userId=${id}`).then((data) => {
        if (!Array.isArray(data?.orders)) throw new Error('Invalid orders response');
        return data.orders;
      }),
    ]);
    const hasUser = userResult.status === 'fulfilled';
    const hasOrders = ordersResult.status === 'fulfilled';
    if (!hasUser && !hasOrders) {
      return res.status(502).json({ error: 'Upstream service unavailable' });
    }
    const result = {
      user: hasUser ? userResult.value : null,
      orders: hasOrders ? ordersResult.value : null,
    };
    if (!hasUser || !hasOrders) {
      result.errors = {};
      if (!hasUser) result.errors.user = 'User service unavailable';
      if (!hasOrders) result.errors.orders = 'Order service unavailable';
      return res.status(206).json(result);
    }
    res.json(result);
  });
  return finishApp(app);
}
