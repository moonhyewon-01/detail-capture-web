# Playwright 공식 이미지 사용 (크롬 실행에 필요한 시스템 라이브러리가 이미 다 설치되어 있음)
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
