FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DISPLAY=:99
ENV PORT=10000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       xvfb \
       fluxbox \
       x11vnc \
       novnc \
       websockify \
       ca-certificates \
       fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium

COPY . .

RUN mkdir -p /app/data /app/data/tmp

EXPOSE 10000

CMD ["npm", "start"]
