FROM node:20-alpine

WORKDIR /app

# Install dependencies if any (production only)
COPY package.json ./
# If package-lock exists, install production deps; otherwise no extra deps needed
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; fi

# Copy application source
COPY . .

# Expose default service port
EXPOSE 3090

# Environment defaults
ENV PORT=3090 \
    HOST=0.0.0.0 \
    NODE_ENV=production

# Start companion server
CMD ["node", "server.mjs"]
