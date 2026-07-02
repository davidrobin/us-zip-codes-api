const express = require('express');
const zipRoutes = require('./routes/zipRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    service: 'usps-zip-api',
    endpoints: [
      'GET  /api/zip-codes            -> all ZIP codes grouped by state',
      'GET  /api/zip-codes/meta       -> cache metadata (source file, fetch time, counts)',
      'GET  /api/zip-codes/states     -> list of state codes available',
      'GET  /api/zip-codes/:state     -> ZIP codes for one state, e.g. /api/zip-codes/CA',
      'POST /api/zip-codes/refresh    -> force re-scrape/re-download from USPS PostalPro',
    ],
  });
});

app.use('/api/zip-codes', zipRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`usps-zip-api listening on http://localhost:${PORT}`);
});
