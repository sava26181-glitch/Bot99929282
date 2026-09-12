
FROM ghcr.io/pixlcore/xyops-shell-image:latest

WORKDIR /app

RUN pip3 install --no-cache-dir yt-dlp SignerPy==0.12.0

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
EXPOSE 3000

CMD ["node", "bot.js"]
