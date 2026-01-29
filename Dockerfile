FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (mineflayer needs some extra deps for node-xmpp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Expose web port
EXPOSE 3000

# Environment
ENV PORT=3000
ENV TZ=Asia/Saigon

# Run web server
CMD ["sh", "-c", "npm run start:web"]
