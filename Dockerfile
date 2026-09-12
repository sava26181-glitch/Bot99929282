FROM python:3.11-slim

# Node.js + системные зависимости
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    nodejs \
    npm \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp + SignerPy (наш гибридный солвер)
RUN pip3 install --no-cache-dir yt-dlp SignerPy==0.12.0

# Playwright + браузеры
RUN pip3 install --no-cache-dir playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN python3 -m playwright install --with-deps chromium

WORKDIR /app

# Node-зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Код
COPY . .

# Проверка что Python и Node оба на месте
RUN python3 -c "from SignerPy import sign; print('SignerPy OK')" && node -v

CMD ["node", "bot.js"]
