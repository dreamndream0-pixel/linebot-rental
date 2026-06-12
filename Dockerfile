FROM node:20-alpine

WORKDIR /app

# 安裝依賴
COPY package*.json ./
RUN npm install --only=production

# 複製程式碼
COPY . .

# 產生 Prisma Client
RUN npx prisma generate

EXPOSE 3000

CMD ["npm", "start"]
