const express = require('express');
const zipService = require('../services/zipService');

const router = express.Router();

/**
 * POST /api/zip-codes/refresh
 * Force a fresh scrape + download + parse, bypassing the cache TTL.
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await zipService.refresh();
    res.json({
      message: 'ZIP code data refreshed from USPS PostalPro',
      sourceFileUrl: result.sourceFileUrl,
      dataVintage: result.dataVintage,
      totalStates: result.states.length,
      totalZips: result.totalZips,
      fetchedAt: new Date(result.fetchedAt).toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/zip-codes
 * Returns ZIP codes grouped by state, each with its full name:
 * { "CA": { "name": "California", "count": 2322, "zipCodes": ["90001", ...] }, ... }
 */
router.get('/', async (req, res, next) => {
  try {
    await zipService.ensureFresh();
    const byState = zipService.getAllByState();

    const enriched = {};
    for (const [code, zipCodes] of Object.entries(byState)) {
      enriched[code] = {
        name: zipService.getStateName(code),
        count: zipCodes.length,
        zipCodes,
      };
    }

    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/zip-codes/meta
 * Returns metadata about the currently cached dataset, including the
 * year/month of the USPS data (parsed from the source file's dated path).
 */
router.get('/meta', async (req, res, next) => {
  try {
    await zipService.ensureFresh();
    const meta = zipService.getCacheMeta();
    res.json({
      ...meta,
      fetchedAt: meta.fetchedAt ? new Date(meta.fetchedAt).toISOString() : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/zip-codes/states
 * Returns the sorted list of states present in the dataset, with full names:
 * [{ "code": "AK", "name": "Alaska" }, ...]
 */
router.get('/states', async (req, res, next) => {
  try {
    await zipService.ensureFresh();
    res.json(zipService.getStates());
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/zip-codes/:state
 * Returns the ZIP codes for a single 2-letter state code, e.g. /api/zip-codes/CA
 */
router.get('/:state', async (req, res, next) => {
  try {
    await zipService.ensureFresh();
    const { state } = req.params;

    if (!/^[A-Za-z]{2}$/.test(state)) {
      return res.status(400).json({ error: 'State must be a 2-letter code, e.g. CA' });
    }

    const zips = zipService.getZipsForState(state);

    if (!zips) {
      return res.status(404).json({ error: `No ZIP codes found for state '${state.toUpperCase()}'` });
    }

    res.json({
      state: state.toUpperCase(),
      name: zipService.getStateName(state),
      count: zips.length,
      zipCodes: zips,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
