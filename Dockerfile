FROM python:3.11-slim

# Ставим Node.js, ffmpeg, yt-dlp и зависимости для Playwright
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    nodejs \
    npm \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Ставим yt-dlp
RUN pip3 install --no-cache-dir yt-dlp SignerPy==0.12.0

# Ставим Playwright и его браузеры
RUN pip3 install --.

no-cache-dir playwright
### КакENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN python3 -m playwright install --with-deps chromium

WORKDIR /app

# Ставим Node-зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Копируем код
COPY . .

# Создаём папку для временных файлов
RUN mkdir -p /app/tmp && chmod 777 /app/tmp

# Запуск
CMD ["node", "bot.js"]
