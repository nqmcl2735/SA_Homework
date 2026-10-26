import { createApp, finishApp, requireIdentity } from '../shared/http.js';

const orders = [
  { id: '101', userId: '1', productName: 'Keyboard', quantity: 1, total: 500000, status: 'completed' },
  { id: '102', userId: '1', productName: 'Mouse', quantity: 2, total: 300000, status: 'pending' },
];

export function createOrderApp() {
  const app = createApp();
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'orders' }));
  app.get('/orders', requireIdentity, (req, res) => {
    const { userId } = req.query;
    if (typeof userId !== 'string' || !userId.trim()) return res.status(400).json({ error: 'userId is required' });
    if (userId !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    res.json({ orders: orders.filter((order) => order.userId === userId) });
  });
  return finishApp(app);
}
