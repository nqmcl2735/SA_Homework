import { createGatewayApp } from './app.js';
import { jwtConfig, required } from '../shared/http.js';
createGatewayApp({
  auth: jwtConfig(), userServiceUrl: required('USER_SERVICE_URL'), orderServiceUrl: required('ORDER_SERVICE_URL'),
}).listen(3000, '0.0.0.0', () => console.log('API Gateway: 3000'));
