
FROM node:19-slim

USER root

WORKDIR /app

RUN apt-get update -o Acquire::Retries=3 && \
    apt-get install -y --no-install-recommends --fix-missing \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages yt-dlp SignerPy==0.12.0

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 3000

CMD ["node", "bot.js"]
