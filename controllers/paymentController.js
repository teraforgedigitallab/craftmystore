const axios = require('axios');
const crypto = require('crypto');
const { StandardCheckoutClient, Env, MetaInfo, StandardCheckoutPayRequest } = require('pg-sdk-node');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const { Cashfree, CFEnvironment } = require('cashfree-pg');

// Initialize Firebase Admin SDK (if not already initialized elsewhere)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
  console.log('Firebase Admin SDK initialized successfully');
}

// Get Firestore instance
const db = admin.firestore();

// Function to store payment data in Firestore
const storePaymentData = async (paymentData) => {
  try {
    // Format payment data for Firestore
    const timestamp = new Date();
    
    const paymentDoc = {
      customerInfo: {
        name: paymentData.customerName || '',
        email: paymentData.customerEmail || '',
        phone: paymentData.customerPhone || ''
      },
      transactionInfo: {
        id: paymentData.merchantTransactionId || '',
        amount: paymentData.amount || 0,
        status: paymentData.status || 'UNKNOWN',
        paymentMethod: paymentData.paymentMethod || 'unknown',
        createdAt: paymentData.createdAt || timestamp.toISOString(),
        updatedAt: paymentData.updatedAt || timestamp.toISOString(),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      },
      planDetails: {
        ecommPlan: paymentData.ecommPlan || '',
        hostingPlan: paymentData.hostingPlan || ''
      }
    };

    // Add transaction ID as document ID for easy retrieval
    await db.collection('payments').doc(paymentData.merchantTransactionId).set(paymentDoc);
    console.log('Payment data stored in Firestore with ID:', paymentData.merchantTransactionId);
    return paymentData.merchantTransactionId;
  } catch (error) {
    console.error('Error storing payment data in Firestore:', error);
    // Just log the error but don't throw it to prevent payment process interruption
    return null;
  }
};

// Store pending payments in memory (use database in production)
global.pendingPayments = global.pendingPayments || {};

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Function to send notification email to admin
const sendAdminNotificationEmail = async (paymentDetails) => {
  try {
    // Extract payment details
    const { customerName, customerEmail, customerPhone, amount, ecommPlan, hostingPlan, merchantTransactionId } = paymentDetails;
    
    // Create email content
    const subject = `New Client Alert: ${customerName} has made a payment!`;
    
    // Format the plans for better readability
    const selectedPackage = [];
    if (ecommPlan) selectedPackage.push(`E-commerce Plan: ${ecommPlan}`);
    if (hostingPlan) selectedPackage.push(`Hosting Plan: ${hostingPlan}`);
    
    const html = `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2 style="color: #4a6ee0;">🎉 Great news! You have a new client!</h2>
        <p>A customer has just completed a payment on CraftMyStore.</p>
        
        <h3 style="margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px;">Client Details:</h3>
        <ul style="list-style-type: none; padding-left: 0;">
          <li><strong>Name:</strong> ${customerName}</li>
          <li><strong>Email:</strong> ${customerEmail}</li>
          <li><strong>Phone:</strong> ${customerPhone || 'Not provided'}</li>
          <li><strong>Transaction ID:</strong> ${merchantTransactionId}</li>
        </ul>
        
        <h3 style="margin-top: 20px; border-bottom: 1px solid #eee; padding-bottom: 10px;">Purchase Details:</h3>
        <ul style="list-style-type: none; padding-left: 0;">
          <li><strong>Amount Paid:</strong> $${amount}</li>
          <li><strong>Selected Package:</strong> ${selectedPackage.join(', ') || 'Custom package'}</li>
        </ul>
        
        <div style="margin-top: 30px; padding: 15px; background-color: #f7f7f7; border-radius: 5px;">
          <p style="margin-top: 0;"><strong>Next Steps:</strong></p>
          <ol>
            <li>Reach out to the client within 24 hours to welcome them</li>
            <li>Set up their account with the purchased packages</li>
            <li>Schedule an onboarding call if needed</li>
          </ol>
        </div>
        
        <p style="margin-top: 30px; font-size: 12px; color: #777;">
          This is an automated message from CraftMyStore platform. Please do not reply directly to this email.
        </p>
      </div>
    `;
    
    // Send email
    await transporter.sendMail({
      from: `"CraftMyStore Notifications" <${process.env.EMAIL_FROM}>`,
      to: process.env.ADMIN_EMAIL,
      subject,
      html
    });
    
    console.log(`Admin notification email sent for customer: ${customerName}`);
    return true;
  } catch (error) {
    console.error('Error sending admin notification email:', error);
    return false;
  }
};

// Initialize Cashfree client based on environment
const getCashfreeClient = () => {
  const environment = process.env.CASHFREE_ENVIRONMENT === 'production' 
    ? CFEnvironment.PRODUCTION 
    : CFEnvironment.SANDBOX;
  
  return new Cashfree(
    environment,
    process.env.CASHFREE_CLIENT_ID,
    process.env.CASHFREE_CLIENT_SECRET
  );
};

// PhonePe Payment Initiation using SDK
exports.initiatePhonePePayment = async (req, res) => {
  try {
    const { amount, ecommPlan, hostingPlan, customerName, customerEmail, customerPhone } = req.body;

    console.log('PhonePe Payment Request:', req.body);

    // Validation
    if (!amount || !customerPhone || !customerEmail || !customerName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: amount, customerPhone, customerEmail, customerName'
      });
    }

    // Validate phone number format
    if (!/^\d{10}$/.test(customerPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Phone number must be exactly 10 digits'
      });
    }

    // Validate amount
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }

    // Generate unique transaction ID
    const merchantTransactionId = `CMS_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // Store payment info for verification
    const paymentInfo = {
      merchantTransactionId,
      amount: parseFloat(amount),
      customerName,
      customerEmail,
      customerPhone,
      ecommPlan,
      hostingPlan,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };

    global.pendingPayments[merchantTransactionId] = paymentInfo;

    // PhonePe production or sandbox environment based on .env
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');

    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;

    console.log(`Using PhonePe ${isProduction ? 'PRODUCTION' : 'SANDBOX'} environment`);

    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);

    // Prepare redirectUrl with transaction details
    const redirectUrl = `${process.env.FRONTEND_URL}/payment-status?merchantTransactionId=${merchantTransactionId}&amount=${amount}&method=phonepe&customer=${encodeURIComponent(customerName)}`;

    // Build metadata
    const metaInfo = MetaInfo.builder()
      .udf1(customerEmail)
      .udf2(customerPhone)
      .udf3(ecommPlan || hostingPlan || '')
      .build();

    // Create payment request using the SDK
    const request = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantTransactionId)
      .amount(Math.round(parseFloat(amount) * 100)) // Convert to paise
      .redirectUrl(redirectUrl)
      .metaInfo(metaInfo)
      .build();

    console.log('PhonePe SDK Request:', request);

    // Make the payment request
    const response = await client.pay(request);
    console.log('PhonePe SDK Response:', response);

    if (response && response.redirectUrl) {
      // Update payment info with order ID and redirect URL
      global.pendingPayments[merchantTransactionId].phonepeOrderId = response.orderId;
      global.pendingPayments[merchantTransactionId].redirectUrl = response.redirectUrl;
      global.pendingPayments[merchantTransactionId].status = 'INITIATED';
      global.pendingPayments[merchantTransactionId].expireAt = response.expireAt;

      return res.json({
        success: true,
        redirectUrl: response.redirectUrl,
        merchantTransactionId,
        orderId: response.orderId,
        message: 'Payment initiated successfully'
      });
    } else {
      console.error('PhonePe SDK Error: Missing redirect URL');
      return res.status(400).json({
        success: false,
        message: 'Payment initiation failed - missing redirect URL',
        error: response
      });
    }

  } catch (error) {
    console.error('PhonePe Payment Error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Payment initiation failed',
      error: error
    });
  }
};

// PhonePe Callback Handler
exports.phonePeCallback = async (req, res) => {
  try {
    console.log('PhonePe Callback received:', {
      body: req.body,
      query: req.query,
      headers: req.headers
    });

    const { merchantTransactionId, status } = req.query;

    if (merchantTransactionId && global.pendingPayments[merchantTransactionId]) {
      global.pendingPayments[merchantTransactionId].status = status || 'COMPLETED';
      global.pendingPayments[merchantTransactionId].updatedAt = new Date().toISOString();
      console.log('Updated payment status for:', merchantTransactionId, 'to:', status);
    }

    res.status(200).json({ success: true, message: 'Callback processed' });
  } catch (error) {
    console.error('PhonePe Callback Error:', error);
    res.status(500).json({ success: false, message: 'Callback failed' });
  }
};

// Verify PhonePe Payment using SDK
exports.verifyPhonePePayment = async (req, res) => {
  try {
    const { merchantTransactionId } = req.params;

    if (!merchantTransactionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing transaction ID'
      });
    }

    console.log('Verifying PhonePe payment for:', merchantTransactionId);

    // Get stored payment info
    if (!global.pendingPayments || !global.pendingPayments[merchantTransactionId]) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    const paymentInfo = global.pendingPayments[merchantTransactionId];

    // PhonePe production or sandbox environment based on .env
    const isProduction = process.env.PHONEPE_BASE_URL.includes('api.phonepe.com');

    // Initialize PhonePe SDK client
    const clientId = process.env.PHONEPE_MERCHANT_ID;
    const clientSecret = process.env.PHONEPE_MERCHANT_KEY;
    const clientVersion = 1;
    const env = isProduction ? Env.PRODUCTION : Env.SANDBOX;

    const client = StandardCheckoutClient.getInstance(clientId, clientSecret, clientVersion, env);

    console.log('Checking payment status using merchantTransactionId:', merchantTransactionId);
    
    // Use getOrderStatus as per PhonePe documentation instead of checkStatus
    const statusResponse = await client.getOrderStatus(merchantTransactionId);
    console.log('PhonePe Status Response:', JSON.stringify(statusResponse, null, 2));

    // Update payment status in memory
    global.pendingPayments[merchantTransactionId].status = statusResponse?.state || 'UNKNOWN';
    global.pendingPayments[merchantTransactionId].verifiedAt = new Date().toISOString();
    global.pendingPayments[merchantTransactionId].paymentDetails = statusResponse;

    // Determine the final status to send to the frontend based on PhonePe state
    if (statusResponse && statusResponse.state === 'COMPLETED') {
      console.log('SUCCESS DETECTED - Payment verified as successful');
      
      // Also check payment details if available
      const paymentDetail = statusResponse.paymentDetails && 
                           statusResponse.paymentDetails.length > 0 ? 
                           statusResponse.paymentDetails[0] : null;
      
      if (paymentDetail && paymentDetail.state !== 'COMPLETED') {
        console.log('WARNING: Order state is COMPLETED but payment detail state is', paymentDetail.state);
      }
      
      // Send admin notification email
      try {
        await sendAdminNotificationEmail(paymentInfo);
        console.log('Admin notification email sent successfully');
      } catch (emailError) {
        console.error('Failed to send admin notification email:', emailError);
      }
      
      // Store payment data in Firestore
      try {
        const firestorePaymentData = {
          ...paymentInfo,
          paymentMethod: 'phonepe',
          status: 'COMPLETED',
          updatedAt: new Date().toISOString()
        };
        
        await storePaymentData(firestorePaymentData);
        console.log('PhonePe payment data stored in Firestore successfully');
      } catch (firestoreError) {
        console.error('Failed to store PhonePe payment data in Firestore:', firestoreError);
        // Don't affect the payment response if Firestore storage fails
      }
      
      return res.json({
        success: true,
        status: 'SUCCESS',
        message: 'Payment successful',
        data: statusResponse
      });
    } else if (statusResponse && statusResponse.state === 'PENDING') {
      console.log('PENDING DETECTED - Payment is still processing');
      return res.json({
        success: false,
        status: 'PENDING',
        message: 'Payment is still processing',
        data: statusResponse
      });
    } else {
      console.log('FAILURE DETECTED - Payment verified as failed or cancelled');
      
      // Extract error information if available
      const paymentDetail = statusResponse.paymentDetails && 
                           statusResponse.paymentDetails.length > 0 ? 
                           statusResponse.paymentDetails[0] : null;
      
      const errorInfo = paymentDetail ? 
                        `Error: ${paymentDetail.errorCode || 'Unknown'} - ${paymentDetail.detailedErrorCode || ''}` : 
                        'No detailed error information available';
      
      return res.json({
        success: false,
        status: 'FAILED',
        message: `Payment failed or was cancelled. ${errorInfo}`,
        data: statusResponse
      });
    }

  } catch (error) {
    console.error('PhonePe Verification Error:', error);
    return res.status(500).json({
      success: false,
      status: 'FAILED',
      message: 'Verification failed due to a server error: ' + error.message
    });
  }
};

// Initiate Cashfree Payment
exports.initiateCashfreePayment = async (req, res) => {
  try {
    const { amount, ecommPlan, hostingPlan, customerName, customerEmail, customerPhone } = req.body;
    
    if (!amount || !customerEmail || !customerName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }
    
    console.log('Cashfree Payment Request:', req.body);
    
    // Generate unique transaction ID
    const merchantTransactionId = `CMS_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    
    // Create return URL with order details
    const returnUrl = `${process.env.FRONTEND_URL}/payment-status?merchantTransactionId=${merchantTransactionId}&amount=${amount}&method=cashfree&customer=${encodeURIComponent(customerName)}`;
    
    // Store payment info for verification
    const paymentInfo = {
      merchantTransactionId,
      amount: parseFloat(amount),
      customerName,
      customerEmail,
      customerPhone,
      ecommPlan,
      hostingPlan,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };
    
    global.pendingPayments[merchantTransactionId] = paymentInfo;
    
    // Initialize Cashfree client
    const cashfree = getCashfreeClient();
    
    // Prepare order request
    const orderRequest = {
      order_id: merchantTransactionId,
      order_amount: amount.toString(),
      order_currency: "INR",
      customer_details: {
        customer_id: `CUST_${Date.now()}`,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone
      },
      order_meta: {
        return_url: returnUrl + '?order_id={order_id}',
        notify_url: process.env.BACKEND_URL + '/api/payment/cashfree-webhook'
      },
      order_note: `CraftMyStore - ${ecommPlan} + ${hostingPlan}`
    };
    
    console.log('Cashfree order request:', JSON.stringify(orderRequest, null, 2));
    
    // Create order in Cashfree
    const response = await cashfree.PGCreateOrder(orderRequest);
    console.log('Cashfree order response:', response.data);
    
    if (response.data && response.data.payment_session_id) {
      // Update payment info with payment session ID
      global.pendingPayments[merchantTransactionId].cashfreeOrderId = response.data.order_id;
      global.pendingPayments[merchantTransactionId].paymentSessionId = response.data.payment_session_id;
      global.pendingPayments[merchantTransactionId].status = 'INITIATED';
      
      return res.json({
        success: true,
        orderId: response.data.order_id,
        paymentSessionId: response.data.payment_session_id,
        merchantTransactionId
      });
    } else {
      console.error('Cashfree Error: Missing payment session ID');
      return res.status(400).json({
        success: false,
        message: 'Payment initiation failed',
        error: response.data
      });
    }
  } catch (error) {
    console.error('Cashfree Payment Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: 'Payment initiation failed: ' + (error.response?.data?.message || error.message)
    });
  }
};

// Verify Cashfree Payment
exports.verifyCashfreePayment = async (req, res) => {
  try {
    const { merchantTransactionId } = req.params;
    
    if (!merchantTransactionId) {
      return res.status(400).json({
        success: false,
        message: 'Missing transaction ID'
      });
    }
    
    console.log('Verifying Cashfree payment for:', merchantTransactionId);
    
    // Get stored payment info
    if (!global.pendingPayments || !global.pendingPayments[merchantTransactionId]) {
      return res.status(404).json({
        success: false,
        message: 'Transaction not found'
      });
    }
    
    const paymentInfo = global.pendingPayments[merchantTransactionId];
    
    // Initialize Cashfree client
    const cashfree = getCashfreeClient();
    
    // Fetch order details from Cashfree
    const response = await cashfree.PGFetchOrder(merchantTransactionId);
    console.log('Cashfree order status response:', JSON.stringify(response.data, null, 2));
    
    const orderStatus = response.data.order_status;
    
    // Update payment status in memory
    global.pendingPayments[merchantTransactionId].status = orderStatus;
    global.pendingPayments[merchantTransactionId].verifiedAt = new Date().toISOString();
    global.pendingPayments[merchantTransactionId].paymentDetails = response.data;
    
    if (orderStatus === 'PAID') {
      console.log('SUCCESS DETECTED - Cashfree payment verified as successful');
      
      // Send admin notification email
      try {
        await sendAdminNotificationEmail(paymentInfo);
        console.log('Admin notification email sent successfully');
      } catch (emailError) {
        console.error('Failed to send admin notification email:', emailError);
      }
      
      // Store payment data in Firestore
      try {
        const firestorePaymentData = {
          ...paymentInfo,
          paymentMethod: 'cashfree',
          status: 'COMPLETED',
          updatedAt: new Date().toISOString()
        };
        
        await storePaymentData(firestorePaymentData);
        console.log('Cashfree payment data stored in Firestore successfully');
      } catch (firestoreError) {
        console.error('Failed to store Cashfree payment data in Firestore:', firestoreError);
        // Don't affect the payment response if Firestore storage fails
      }
      
      return res.json({
        success: true,
        status: 'SUCCESS',
        message: 'Payment successful',
        data: response.data
      });
    } else if (orderStatus === 'ACTIVE') {
      console.log('PENDING DETECTED - Payment is still processing');
      return res.json({
        success: false,
        status: 'PENDING',
        message: 'Payment is still processing',
        data: response.data
      });
    } else {
      console.log('FAILURE DETECTED - Payment verified as failed or cancelled');
      
      return res.json({
        success: false,
        status: 'FAILED',
        message: `Payment failed or was cancelled. Status: ${orderStatus}`,
        data: response.data
      });
    }
  } catch (error) {
    console.error('Cashfree Verification Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      status: 'FAILED',
      message: 'Verification failed due to a server error: ' + (error.response?.data?.message || error.message)
    });
  }
};

// Cashfree Webhook Handler
exports.cashfreeWebhook = async (req, res) => {
  try {
    console.log('Cashfree Webhook received:', {
      body: req.body,
      headers: req.headers
    });
    
    const eventData = req.body;
    const orderId = eventData.data?.order?.order_id;
    const orderStatus = eventData.data?.order?.order_status;
    
    if (orderId && global.pendingPayments[orderId]) {
      global.pendingPayments[orderId].status = orderStatus === 'PAID' ? 'COMPLETED' : orderStatus;
      global.pendingPayments[orderId].updatedAt = new Date().toISOString();
      global.pendingPayments[orderId].webhookData = eventData;
      console.log('Updated payment status for:', orderId, 'to:', orderStatus);
      
      // If payment is successful, send notification and store in Firestore
      if (orderStatus === 'PAID') {
        const paymentInfo = global.pendingPayments[orderId];
        
        // Send admin notification email
        try {
          await sendAdminNotificationEmail(paymentInfo);
          console.log('Admin notification email sent successfully from webhook');
        } catch (emailError) {
          console.error('Failed to send admin notification email from webhook:', emailError);
        }
        
        // Store payment data in Firestore
        try {
          const firestorePaymentData = {
            ...paymentInfo,
            paymentMethod: 'cashfree',
            status: 'COMPLETED',
            updatedAt: new Date().toISOString()
          };
          
          await storePaymentData(firestorePaymentData);
          console.log('Cashfree payment data stored in Firestore successfully from webhook');
        } catch (firestoreError) {
          console.error('Failed to store Cashfree payment data in Firestore from webhook:', firestoreError);
        }
      }
    }
    
    res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('Cashfree Webhook Error:', error);
    res.status(500).json({ success: false, message: 'Webhook failed' });
  }
};
