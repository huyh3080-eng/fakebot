FROM node:20-bookworm-slim

WORKDIR /app

# Copy dependency files first (tận dụng cache)
COPY package*.json ./

# NPM ổn định hơn trong Docker
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_progress=false \
    npm_config_update_notifier=false

# Nếu có package-lock.json thì dùng npm ci (ổn định hơn)
RUN npm ci

# Copy source code
COPY . .

EXPOSE 3000

ENV PORT=3000
ENV TZ=Asia/Ho_Chi_Minh

CMD ["npm", "run", "start:web"]
