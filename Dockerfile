# Usamos una imagen de Microsoft que YA TIENE los navegadores y dependencias instalados
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Creamos la carpeta de trabajo
WORKDIR /app

# Copiamos tus archivos al contenedor
COPY package.json robot.js ./

# Instalamos las librerías de Node
RUN npm install

# Comando para arrancar el robot
CMD ["node", "robot.js"]
