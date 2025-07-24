const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// Health check route
router.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Payment API is working' });
});

// PhonePe routes - matching frontend calls
router.post('/initiate-phonepe', paymentController.initiatePhonePePayment);
router.post('/phonepe-callback', paymentController.phonePeCallback);
router.get('/verify-phonepe/:merchantTransactionId', paymentController.verifyPhonePePayment);

// PayPal routes
router.post('/initiate-paypal', paymentController.initiatePayPalPayment);
router.post('/capture-paypal', paymentController.capturePayPalPayment);

module.exports = router;