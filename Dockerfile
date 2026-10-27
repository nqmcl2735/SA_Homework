FROM node:22-alpine AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY user-service ./user-service
COPY order-service ./order-service
COPY api-gateway ./api-gateway
USER node
CMD ["node", "api-gateway/server.js"]

FROM runtime AS test
# Allow the benchmark to save /app/benchmark-results.json as the node user.
USER root
RUN chown node:node /app
USER node
COPY test ./test
CMD ["npm", "test"]
