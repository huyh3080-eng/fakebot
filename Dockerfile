FROM node:20-bookworm-slim

WORKDIR /app

# Cài deps hệ thống (phòng khi có native modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    build-essential \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files trước để cache tốt
COPY package*.json ./

# NPM config cho môi trường Docker / CI
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_progress=false \
    npm_config_update_notifier=false \
    NODE_ENV=production \
    TZ=Asia/Ho_Chi_Minh

# Cài dependencies
# ⚠️ express PHẢI nằm trong "dependencies"
RUN npm ci

# Copy source code
COPY . .

EXPOSE 3000

# Chạy web
CMD ["npm", "run", "start:web"]
