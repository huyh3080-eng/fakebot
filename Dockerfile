FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (mineflayer / native modules may need build tools)
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

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
