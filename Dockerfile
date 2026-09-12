FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

CMD ["node", "bot.js"]
