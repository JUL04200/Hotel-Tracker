FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    RAILWAY_ENVIRONMENT=true

WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts
COPY . .

EXPOSE 3737
CMD ["node", "server.js"]
