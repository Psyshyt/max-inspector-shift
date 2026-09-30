FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js setup-webhook.js ./
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV STORE_PATH=/app/data/store.json

EXPOSE 3000

CMD ["node", "server.js"]
