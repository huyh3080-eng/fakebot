# Use full Node image - no apt-get needed (avoids DNS issues in build)
FROM node

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

# Run web server
CMD ["sh", "-c", "npm run start:web"]
