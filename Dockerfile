# Use full Node image - no apt-get needed (avoids DNS issues in build)
FROM node

WORKDIR /app

COPY . /app

RUN npm install
EXPOSE 3000

# Environment
ENV PORT=3000
ENV TZ=Asia/Saigon

# Run web server
CMD ["sh", "-c", "npm run start:web"]
