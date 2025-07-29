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

// Cashfree routes
router.post('/initiate-cashfree', paymentController.initiateCashfreePayment);
router.get('/verify-cashfree/:merchantTransactionId', paymentController.verifyCashfreePayment);
router.post('/cashfree-webhook', paymentController.cashfreeWebhook);

module.exports = router;
