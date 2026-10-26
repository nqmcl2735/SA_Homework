import { createOrderApp } from './app.js';
createOrderApp().listen(3002, process.env.SERVICE_HOST || '127.0.0.1', () => console.log('Order Service: 3002'));
