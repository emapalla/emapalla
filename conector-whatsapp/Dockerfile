FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/index.js"]
