# Этап 1: берём Node из официального образа
FROM node:20-slim AS node

# Этап 2: Python-образ
FROM python:3.11-slim

WORKDIR /app

# Копируем Node и npm из первого этапа
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules

# Создаём симлинк для npm/npx
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Python-зависимости
RUN python3 -m pip install --no-cache-dir yt-dlp SignerPy==0.12.0

# Node-зависимости
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 3000

CMD ["node", "bot.js"]
