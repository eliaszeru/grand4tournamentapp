const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const connectDB = require("./config/db");

// Load environment variables
dotenv.config();
console.log("MONGODB_URI:", process.env.MONGODB_URI);
console.log("NODE_ENV:", process.env.NODE_ENV);

// Connect to MongoDB
connectDB();

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Use API prefix from environment or default to '/api'
const API_PREFIX = process.env.API_PREFIX || "/api";

// Routes
app.use(`${API_PREFIX}/auth`, require("./routes/auth"));
app.use(`${API_PREFIX}/tournaments`, require("./routes/tournament"));

// Serve static frontend files
app.use(express.static(path.join(__dirname, "../frontend/public")));

// Catch-all to serve index.html for client-side routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/public/index.html"));
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});