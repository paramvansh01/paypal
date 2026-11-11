# Kept on Render (or any Docker host). Playwright's image already has Chromium,
# WebKit and their system libraries, which the verifier quorum needs.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=10000

COPY package.json package-lock.json ./
# tsx (a dev dependency) runs the TypeScript server directly: there is no build step.
RUN npm ci --include=dev && npm cache clean --force

COPY . .
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
