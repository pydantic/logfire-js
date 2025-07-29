import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 8989;

// Enable CORS - handle origins dynamically to avoid wildcard issues with credentials
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true
}));

// Parse JSON bodies
app.use(express.json());

const logfireUrl = process.env.LOGFIRE_URL || 'http://localhost:4318/v1/traces';
const token = process.env.LOGFIRE_TOKEN || ''


// Single endpoint: POST /client-traces
app.post('/client-traces', async (req, res) => {
  const response = await fetch(logfireUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token
    },
    body: JSON.stringify(req.body),
  })
  res.status(response.status).send(response.body)
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}, proxying to ${logfireUrl}`);
});

export default app;

