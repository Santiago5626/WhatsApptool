FROM node:18

# Instalar dependencias del sistema para Puppeteer y Chrome
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    librender1 \
    libss2 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    libxshmfence1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Crear directorio de trabajo
WORKDIR /app

# Copiar archivos de dependencias
COPY package*.json ./

# Instalar dependencias de Node
RUN npm install

# Descargar el binario de Chrome para Puppeteer
RUN npx puppeteer browsers install chrome

# Copiar el resto del código fuente
COPY . .

# Exponer el puerto que usa Express
EXPOSE 3000

# Variable de entorno para Puppeteer
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Iniciar la aplicación
CMD ["npm", "start"]
