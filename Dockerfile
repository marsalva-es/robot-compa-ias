# ACTUALIZADO A LA VERSIÓN QUE PIDE EL ERROR (1.57.0)
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package.json robot.js ./

# Instalamos dependencias
RUN npm install

# Arrancamos el robot
CMD ["node", "robot.js"]
