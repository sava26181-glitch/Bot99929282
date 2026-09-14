FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=10000

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium

COPY . .

RUN mkdir -p /app/data /app/data/tmp

EXPOSE 10000

CMD ["npm", "start"]
