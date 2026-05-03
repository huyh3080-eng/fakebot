FROM node:20-alpine

# Install dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Expose web port
EXPOSE 3000

# Environment
ENV PORT=3000
ENV TZ=Asia/Saigon
ENV MC_CLIENT_BRAND=vanilla
ENV MC_ALLOW_PLUGIN_CHANNELS=0
ENV MC_ALLOW_BRAND_CHANNEL=1

# Run web server
CMD ["sh", "-c", "npm run start:web"]
