FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8000
ENV DB_PATH=/var/data/data.json

EXPOSE 8000

CMD ["node", "server/index.js"]
