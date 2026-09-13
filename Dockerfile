FROM node:20-bookworm-slim

USER root

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-dev \
    ca-certificates \
    curl \
    build-essential \
    libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --break-system-packages \
    yt-dlp \
    SignerPy==0.12.0 \
    temp-gmail \
    curl-cffi

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 3000

CMD ["node", "bot.js"]
