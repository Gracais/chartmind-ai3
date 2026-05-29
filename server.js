import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import analyzeRoute from './routes/analyze.js';

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, 'uploads');

fs.mkdirSync(uploadDir, { recursive: true });

app.use(cors());

app.use(express.json({
  limit: '25mb'
}));

// API routes before static so /analyze isn't shadowed
app.use('/analyze', analyzeRoute);

// Serve static files from root
app.use(express.static(__dirname));

// Serve index.html
app.get('/', (_, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

// Error handler must be registered AFTER routes
app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'MALFORMED_JSON',
        message: 'Request body is not valid JSON.',
      },
    });
  }
  return next(error);
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(
    `ChartMind AI running on port ${PORT}`
  );
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to an available port and restart ChartMind AI.`);
    process.exit(1);
  }

  console.error('ChartMind AI failed to start:', error);
  process.exit(1);
});
