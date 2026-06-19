FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    xvfb \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    RAILWAY_ENVIRONMENT=true \
    DISPLAY=:99

WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .

EXPOSE 3737
CMD Xvfb :99 -screen 0 1366x768x24 & node server.js
