FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY user-service ./user-service
COPY order-service ./order-service
COPY api-gateway ./api-gateway
USER node
CMD ["node", "api-gateway/server.js"]
