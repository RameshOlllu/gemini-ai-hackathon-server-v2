# Node.js image with version
FROM node:20.17.0

# Setting the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install the dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port on which your app will run
EXPOSE 8080

# Command to run the app
CMD ["node", "app.js"]