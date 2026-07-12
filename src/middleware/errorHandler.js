/**
 * errorHandler.js — Global Error Handling Middleware
 *
 * Catches all unhandled errors thrown or passed via next(err) and
 * returns a structured JSON response. Also includes a validation
 * error formatter for express-validator results.
 */

const { validationResult } = require('express-validator');

/**
 * Formats express-validator errors into a clean array.
 * Use at the top of any route handler that uses validation chains.
 *
 * @example
 *   const errors = formatValidationErrors(req);
 *   if (errors) return res.status(400).json(errors);
 */
function formatValidationErrors(req) {
  const result = validationResult(req);
  if (result.isEmpty()) return null;

  return {
    success: false,
    error: 'Validation failed',
    details: result.array().map((e) => ({
      field:   e.path,
      message: e.msg,
      value:   e.value,
    })),
  };
}

/**
 * Express error-handling middleware (must have 4 parameters).
 * Place this LAST in the middleware chain.
 */
// eslint-disable-next-line no-unused-vars
function globalErrorHandler(err, _req, res, _next) {
  // Log the full error in non-production environments
  if (process.env.NODE_ENV !== 'production') {
    console.error('❌ Unhandled error:', err);
  } else {
    console.error('❌ Error:', err.message);
  }

  // Multer file-size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      error: 'File too large. Maximum upload size is 10 MB.',
    });
  }

  // Multer unexpected field
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      success: false,
      error: 'Unexpected file field in the request.',
    });
  }

  // Firebase auth errors
  if (err.code && err.code.startsWith('auth/')) {
    return res.status(401).json({
      success: false,
      error: err.message,
    });
  }

  // Neo4j errors
  if (err.code && (err.code.startsWith('Neo.') || err.code === 'ServiceUnavailable')) {
    return res.status(503).json({
      success: false,
      error: 'Graph database temporarily unavailable. Please retry.',
    });
  }

  // Default 500
  const statusCode = err.statusCode || err.status || 500;
  res.status(statusCode).json({
    success: false,
    error:
      process.env.NODE_ENV === 'production'
        ? 'An internal server error occurred.'
        : err.message || 'Unknown error',
  });
}

/**
 * Catch-all 404 handler for undefined routes.
 * Place this BEFORE globalErrorHandler.
 */
function notFoundHandler(_req, res) {
  res.status(404).json({
    success: false,
    error: 'The requested endpoint does not exist.',
  });
}

module.exports = {
  formatValidationErrors,
  globalErrorHandler,
  notFoundHandler,
};
