# Email Autoresponder Implementation Guide

## Overview
This guide provides step-by-step instructions to implement an automated email responder system that sends emails to customers on Day 3, 7, 14, and 30 after they submit their order.

## Requirements
- Send automated emails on Day 3, 7, 14, and 30 after customer submission
- Track email delivery status (sent, failed, scheduled)
- Integrate with existing TicketClaim system
- Provide admin dashboard to monitor email campaigns
- Use SendGrid for reliable email delivery (handles Vercel's 10-second timeout issues)

## Files to Create/Modify

### 1. Models
#### Create: `models/FeedbackTracker.js`
```javascript
const mongoose = require('mongoose');

// Email Template Schema - for customizable email templates
const EmailTemplateSchema = new mongoose.Schema({
  day: { type: Number, required: true, min: 1, max: 30 },
  subject: { type: String, required: true },
  htmlContent: { type: String, required: true },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Email Schedule Schema - tracks individual email statuses
const EmailScheduleSchema = new mongoose.Schema({
  scheduledDate: { type: Date, required: true },
  sent: { type: Boolean, default: false },
  sentAt: { type: Date },
  error: { type: String },
  messageId: { type: String }, // For tracking via SendGrid
  opened: { type: Boolean, default: false },
  openCount: { type: Number, default: 0 },
  clicked: { type: Boolean, default: false }
}, { _id: false });

// Main Feedback Tracker Schema
const FeedbackTrackerSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true },
  customerEmail: { type: String, required: true },
  customerName: { type: String, required: true },
  asin: { type: String },
  productName: { type: String },
  productUrl: { type: String },
  reviewUrl: { type: String },
  submissionDate: { type: Date, default: Date.now },
  emailSchedule: {
    day3: EmailScheduleSchema,
    day7: EmailScheduleSchema,
    day14: EmailScheduleSchema,
    day30: EmailScheduleSchema
  },
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'unreviewed', 'cancelled'],
    default: 'pending'
  },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Static method to create scheduled dates
FeedbackTrackerSchema.statics.createScheduledDates = function(submissionDate) {
  const schedule = {};
  
  // Day 3 email
  const day3 = new Date(submissionDate);
  day3.setDate(day3.getDate() + 3);
  schedule.day3 = { scheduledDate: day3 };

  // Day 7 email
  const day7 = new Date(submissionDate);
  day7.setDate(day7.getDate() + 7);
  schedule.day7 = { scheduledDate: day7 };

  // Day 14 email
  const day14 = new Date(submissionDate);
  day14.setDate(day14.getDate() + 14);
  schedule.day14 = { scheduledDate: day14 };

  // Day 30 email
  const day30 = new Date(submissionDate);
  day30.setDate(day30.getDate() + 30);
  schedule.day30 = { scheduledDate: day30 };

  return schedule;
};

// Instance method to mark as reviewed
FeedbackTrackerSchema.methods.markAsReviewed = async function() {
  this.status = 'reviewed';
  this.isActive = false;
  this.updatedAt = new Date();
  return await this.save();
};

// Instance method to mark as unreviewed
FeedbackTrackerSchema.methods.markAsUnreviewed = async function() {
  this.status = 'unreviewed';
  this.isActive = false;
  this.updatedAt = new Date();
  return await this.save();
};

// Instance method to cancel tracking
FeedbackTrackerSchema.methods.cancelTracking = async function() {
  this.status = 'cancelled';
  this.isActive = false;
  this.updatedAt = new Date();
  return await this.save();
};

const FeedbackTracker = mongoose.model('FeedbackTracker', FeedbackTrackerSchema);
const EmailTemplate = mongoose.model('EmailTemplate', EmailTemplateSchema);

module.exports = FeedbackTracker;
module.exports.EmailTemplate = EmailTemplate;
```

### 2. Services
#### Create: `services/emailScheduler.js`
```javascript
const sgMail = require('@sendgrid/mail');
const FeedbackTracker = require('../models/FeedbackTracker');
const EmailTemplate = require('../models/FeedbackTracker').EmailTemplate;
const fs = require('fs');
const path = require('path');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log('✅ SendGrid API initialized');
} else {
  console.warn('⚠️  WARNING: SENDGRID_API_KEY not found in environment variables!');
  console.warn('Emails will fail to send. Please add SENDGRID_API_KEY to your .env file.');
}

// SendGrid configuration - much faster than Gmail SMTP!
const RATE_LIMIT = {
  MAX_EMAILS_PER_RUN: 10, // SendGrid API is fast, can handle more
  DELAY_BETWEEN_EMAILS: 100, // 100ms delay (SendGrid is quick)
  MAX_DAILY_EMAILS: 100, // SendGrid free tier limit
  VERCEL_TIMEOUT_MS: 8000 // 8s timeout buffer for Vercel
};

// From email - configure in SendGrid dashboard (Sender Authentication)
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@studykey.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Study Key';

// Helper: Sleep function for rate limiting
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Load HTML email template (checks DB first, then falls back to file)
const loadEmailTemplate = async (dayNumber, customerName, productName = '', reviewUrl = '', productUrl = '') => {
  try {
    // Try to load from database first
    const dbTemplate = await EmailTemplate.findOne({ day: dayNumber, isActive: true });
    
    if (dbTemplate && dbTemplate.htmlContent) {
      // Use database template
      let html = dbTemplate.htmlContent;
      html = html.replace(/{{customerName}}/g, customerName);
      html = html.replace(/{{productName}}/g, productName || 'your product');
      html = html.replace(/{{reviewUrl}}/g, reviewUrl || 'https://www.amazon.com/review/create-review');
      html = html.replace(/{{productUrl}}/g, productUrl || 'https://www.amazon.com');
      return html;
    }
  } catch (error) {
    console.log(`No custom template in DB for day ${dayNumber}, using file template`);
  }
  
  // Fall back to file template
  const templatePath = path.join(__dirname, '..', 'views', 'email', `feedback-day${dayNumber}.html`);
  
  try {
    let html = fs.readFileSync(templatePath, 'utf8');
    // Replace placeholders
    html = html.replace(/{{customerName}}/g, customerName);
    html = html.replace(/{{productName}}/g, productName || 'your product');
    html = html.replace(/{{reviewUrl}}/g, reviewUrl || 'https://www.amazon.com/review/create-review');
    html = html.replace(/{{productUrl}}/g, productUrl || 'https://www.amazon.com');
    return html;
  } catch (error) {
    console.error(`Error loading template for day ${dayNumber}:`, error);
    // Fallback to simple text if template not found
    return getDefaultEmailContent(dayNumber, customerName, productName, reviewUrl, productUrl);
  }
};

// Fallback email content
const getDefaultEmailContent = (dayNumber, customerName, productName = '', reviewUrl = '', productUrl = '') => {
  const productDisplay = productName ? productName : 'your product';
  const finalReviewUrl = reviewUrl || 'https://www.amazon.com/review/create-review';
  const finalProductUrl = productUrl || 'https://www.amazon.com';
  
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2>Hi ${customerName}! 👋</h2>
      
      <p>It's been ${dayNumber} days since you claimed your Study Key reward. We hope you're enjoying <strong>${productDisplay}</strong>!</p>
      
      <p><strong>Would you mind sharing your experience?</strong></p>
      
      <p>Your honest Amazon review helps us improve and helps other customers make informed decisions. It only takes a minute!</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${finalReviewUrl}" 
           style="background-color: #FF9900; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
          Write Your Review
        </a>
      </div>
      
      ${productUrl ? `<p style="text-align: center; margin: 20px 0;">
        <a href="${finalProductUrl}" style="color: #0066c0; text-decoration: none;">View ${productDisplay} on Amazon</a>
      </p>` : ''}
      
      <p>Thank you for being part of our community!</p>
      
      <p style="color: #666; font-size: 12px; margin-top: 30px;">
        You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
      </p>
    </div>
  `;
};

// Get email subject by day (checks DB first, then defaults)
const getEmailSubject = async (dayNumber, customerName) => {
  try {
    const dbTemplate = await EmailTemplate.findOne({ day: dayNumber, isActive: true });
    if (dbTemplate && dbTemplate.subject) {
      return dbTemplate.subject.replace(/{{customerName}}/g, customerName);
    }
  } catch (error) {
    console.log(`No custom subject in DB for day ${dayNumber}, using default`);
  }
  
  // Default subjects
  const subjects = {
    3: `${customerName}, how's your Study Key product? 🎯`,
    7: `Quick favor - Share your Study Key experience? 📝`,
    14: `${customerName}, your feedback matters to us! 💭`,
    30: `Final reminder: Share your Study Key review 🌟`
  };
  return subjects[dayNumber] || `Study Key - Review Request`;
};

/**
 * Send a single feedback email via SendGrid
 */
async function sendFeedbackEmail(tracker, dayNumber) {
  console.log(`\n📧 Sending Day ${dayNumber} email to ${tracker.orderId}`);
  
  try {
    // Check for SendGrid configuration
    if (!process.env.SENDGRID_API_KEY) {
      const error = 'SendGrid API key not configured';
      console.error(`❌ ${error}`);
      tracker.emailSchedule[`day${dayNumber}`].error = error;
      await tracker.save();
      return { success: false, error: error };
    }
    
    // Load template and subject (combined to save time)
    const [emailHtml, subject] = await Promise.all([
      loadEmailTemplate(
        dayNumber, 
        tracker.customerName,
        tracker.productName || '',
        tracker.reviewUrl || '',
        tracker.productUrl || ''
      ),
      getEmailSubject(dayNumber, tracker.customerName)
    ]);
    
    // Send email via SendGrid API (much faster than SMTP!)
    const msg = {
      to: tracker.customerEmail,
      from: {
        email: FROM_EMAIL,
        name: FROM_NAME
      },
      subject: subject,
      html: emailHtml,
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true }
      },
      customArgs: {
        orderId: tracker.orderId,
        emailDay: `day${dayNumber}`
      }
    };
    
    const response = await sgMail.send(msg);
    
    // Check response status (202 = accepted)
    if (response[0].statusCode === 202) {
      console.log(`✅ Day ${dayNumber} sent to ${tracker.customerEmail}`);
      
      // Mark as sent
      tracker.emailSchedule[`day${dayNumber}`].sent = true;
      tracker.emailSchedule[`day${dayNumber}`].sentAt = new Date();
      tracker.emailSchedule[`day${dayNumber}`].error = null;
      tracker.emailSchedule[`day${dayNumber}`].messageId = response[0].headers['x-message-id'];
      await tracker.save();
      
      return { success: true, messageId: response[0].headers['x-message-id'] };
    } else {
      const errorMessage = `Unexpected status code: ${response[0].statusCode}`;
      console.error(`❌ ${errorMessage}`);
      
      tracker.emailSchedule[`day${dayNumber}`].error = errorMessage;
      tracker.emailSchedule[`day${dayNumber}`].sent = false;
      await tracker.save();
      
      return { success: false, error: errorMessage };
    }
    
  } catch (error) {
    console.error(`\n❌ FAILED to send Day ${dayNumber} email!`);
    console.error(`Error: ${error.message}`);
    
    // Handle SendGrid specific errors
    if (error.response) {
      console.error(`SendGrid Error Code: ${error.code}`);
      console.error(`SendGrid Error Body:`, JSON.stringify(error.response.body, null, 2));
    }
    
    // Mark as failed in database
    tracker.emailSchedule[`day${dayNumber}`].error = error.message || 'Unknown error';
    tracker.emailSchedule[`day${dayNumber}`].sent = false;
    await tracker.save();
    
    return { success: false, error: error.message || 'Unknown error' };
  }
}

/**
 * Process all pending emails (called by cron job)
 * Optimized for Vercel's 10-second timeout
 */
async function processPendingEmails() {
  const startTime = Date.now();
  const results = {
    processed: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    timedOut: false,
    errors: []
  };

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start of today
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1); // Start of tomorrow
    
    console.log(`⏰ Time budget: ${RATE_LIMIT.VERCEL_TIMEOUT_MS}ms`);
    
    // Find all active trackers with emails due today (optimized query)
    const trackers = await FeedbackTracker.find({
      isActive: true,
      status: 'pending',
      $or: [
        {
          'emailSchedule.day3.sent': false,
          'emailSchedule.day3.scheduledDate': { $gte: today, $lt: tomorrow }
        },
        {
          'emailSchedule.day7.sent': false,
          'emailSchedule.day7.scheduledDate': { $gte: today, $lt: tomorrow }
        },
        {
          'emailSchedule.day14.sent': false,
          'emailSchedule.day14.scheduledDate': { $gte: today, $lt: tomorrow }
        },
        {
          'emailSchedule.day30.sent': false,
          'emailSchedule.day30.scheduledDate': { $gte: today, $lt: tomorrow }
        }
      ]
    })
    .select('orderId customerEmail customerName productName asin reviewUrl productUrl emailSchedule status')
    .limit(RATE_LIMIT.MAX_EMAILS_PER_RUN);
    
    console.log(`Found ${trackers.length} trackers with pending emails for today`);
    
    // Process each tracker with timeout protection
    for (const tracker of trackers) {
      // Check if we're approaching timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > RATE_LIMIT.VERCEL_TIMEOUT_MS) {
        console.log(`⚠️  Approaching timeout limit (${elapsed}ms), stopping early`);
        results.timedOut = true;
        results.skipped = trackers.length - results.processed;
        break;
      }
      
      // Check which day to send
      const daysToCheck = [30, 14, 7, 3]; // Priority: later days first
      
      for (const day of daysToCheck) {
        const dayKey = `day${day}`;
        const emailData = tracker.emailSchedule[dayKey];
        
        if (!emailData.sent && 
            emailData.scheduledDate >= today && 
            emailData.scheduledDate < tomorrow) {
          
          results.processed++;
          
          // Send email with rate limiting
          const result = await sendFeedbackEmail(tracker, day);
          
          if (result.success) {
            results.sent++;
          } else {
            results.failed++;
            results.errors.push({
              orderId: tracker.orderId,
              day: day,
              error: result.error
            });
          }
          
          // Rate limiting delay (only if not the last email)
          if (results.processed < trackers.length) {
            await sleep(RATE_LIMIT.DELAY_BETWEEN_EMAILS);
          }
          
          break; // Only send one email per tracker per run
        }
      }
      
      // Check if we should stop after day 30
      if (tracker.emailSchedule.day30.sent && tracker.status === 'pending') {
        await tracker.markAsUnreviewed();
        console.log(`Marked tracker ${tracker.orderId} as unreviewed (all emails sent, no review)`);
      }
    }
    
    const duration = Date.now() - startTime;
    
    console.log(`\n=== Email Processing Summary ===`);
    console.log(`Duration: ${duration}ms`);
    console.log(`Processed: ${results.processed}`);
    console.log(`Sent: ${results.sent}`);
    console.log(`Failed: ${results.failed}`);
    console.log(`Skipped: ${results.skipped}`);
    if (results.timedOut) {
      console.log(`⚠️  Timed out: true (will process remaining emails on next run)`);
    }
    if (results.errors.length > 0) {
      console.log(`\n❌ Errors:`);
      results.errors.forEach(err => {
        console.log(`  Order: ${err.orderId} | Day: ${err.day} | Error: ${err.error}`);
      });
    }
    console.log(`==============================\n`);
    
    return results;
    
  } catch (error) {
    console.error('Error in processPendingEmails:', error);
    throw error;
  }
}

/**
 * Send a test email via SendGrid (for testing purposes)
 */
async function sendTestEmail(email, name = 'Test User') {
  try {
    if (!process.env.SENDGRID_API_KEY) {
      return { success: false, error: 'SendGrid API key not configured' };
    }
    
    const msg = {
      to: email,
      from: {
        email: FROM_EMAIL,
        name: FROM_NAME
      },
      subject: 'Test Email - Study Key Feedback System',
      html: getDefaultEmailContent(3, name),
      trackingSettings: {
        clickTracking: { enable: true },
        openTracking: { enable: true }
      }
    };
    
    const response = await sgMail.send(msg);
    
    return { 
      success: true, 
      messageId: response[0].headers['x-message-id'],
      statusCode: response[0].statusCode
    };
  } catch (error) {
    console.error('Test email error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendFeedbackEmail,
  processPendingEmails,
  sendTestEmail,
  RATE_LIMIT
};
```

### 3. API Routes
#### Create: `api/cron/process-emails.js`
```javascript
const { processPendingEmails } = require('../../services/emailScheduler');
const mongoose = require('mongoose');

// MongoDB connection for serverless
let cachedConnection = null;

async function connectToDatabase() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    console.log('✅ Using cached MongoDB connection');
    return cachedConnection;
  }

  console.log('🔗 Connecting to MongoDB...');
  const startConnect = Date.now();
  
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000, // Fail fast if can't connect
      socketTimeoutMS: 10000,
      maxPoolSize: 1, // Minimal for serverless
    });
    
    cachedConnection = conn;
    console.log(`✅ MongoDB connected in ${Date.now() - startConnect}ms`);
    return conn;
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    throw error;
  }
}

/**
 * Vercel Cron Job Handler
 * Runs daily at 9 AM UTC to process pending feedback emails
 * 
 * Vercel Cron Schedule: 0 9 * * * (Daily at 9 AM UTC)
 */
module.exports = async (req, res) => {
  const startTime = Date.now();
  
  // Log immediately to show cron started
  console.log('========================================');
  console.log('🔄 CRON JOB STARTED');
  console.log('Time:', new Date().toISOString());
  console.log('Path:', req.url);
  console.log('Method:', req.method);
  console.log('========================================');
  
  // Verify this is a valid cron request
  const authHeader = req.headers['authorization'];
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  
  if (!process.env.CRON_SECRET) {
    console.error('❌ CRON_SECRET not configured in environment variables!');
    return res.status(500).json({ 
      success: false, 
      error: 'CRON_SECRET not configured',
      timestamp: new Date().toISOString()
    });
  }
  
  if (authHeader !== expectedAuth) {
    console.error('❌ Unauthorized cron request');
    console.error('Received auth:', authHeader ? 'Bearer ***' : 'None');
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized',
      timestamp: new Date().toISOString()
    });
  }
  
  console.log('✅ Authorization verified');
  
  try {
    // Connect to MongoDB first!
    await connectToDatabase();
    
    console.log('\n📧 Starting email processing...');
    
    const results = await processPendingEmails();
    
    const duration = Date.now() - startTime;
    
    console.log('\n========================================');
    console.log('✅ CRON JOB COMPLETED SUCCESSFULLY');
    console.log('Duration:', duration + 'ms');
    console.log('Processed:', results.processed);
    console.log('Sent:', results.sent);
    console.log('Failed:', results.failed);
    console.log('Skipped:', results.skipped);
    if (results.errors && results.errors.length > 0) {
      console.log('Errors:', JSON.stringify(results.errors, null, 2));
    }
    console.log('========================================\n');
    
    return res.status(200).json({
      success: true,
      message: 'Email processing completed',
      results: results,
      duration: duration,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.error('\n========================================');
    console.error('❌ CRON JOB FAILED');
    console.error('Duration:', duration + 'ms');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    console.error('========================================\n');
    
    return res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      duration: duration,
      timestamp: new Date().toISOString()
    });
  }
};
```

### 4. Email Templates
#### Create directory: `views/email/`
#### Create: `views/email/feedback-day3.html`
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, how's your Study Key product?</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 👋</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been 3 days since you claimed your Study Key reward. We hope you're enjoying <strong>{{productName}}</strong>!
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>Would you mind sharing your experience?</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Your honest Amazon review helps us improve and helps other customers make informed decisions. It only takes a minute!
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Write Your Review
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Thank you for being part of our community!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

#### Create: `views/email/feedback-day7.html`
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, share your Study Key experience?</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 📝</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been 7 days since you received your Study Key product. How are you finding <strong>{{productName}}</strong>?
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>We'd love to hear your thoughts!</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Sharing your experience on Amazon helps other customers discover great products like yours. Plus, it helps us continue to offer quality rewards!
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Leave Your Review
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Your feedback means a lot to us!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

#### Create: `views/email/feedback-day14.html`
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, your feedback matters!</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 💭</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been 2 weeks since you received your Study Key product. We hope <strong>{{productName}}</strong> continues to meet your expectations!
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>Your feedback really matters to us and other customers.</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Taking a moment to leave an Amazon review helps us understand what we're doing right and where we can improve. Plus, it guides other customers in their purchasing decisions.
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Share Your Thoughts
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Thank you for taking the time to help us grow!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

#### Create: `views/email/feedback-day30.html`
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, final review reminder</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 🌟</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been a month since you received your Study Key product. We hope <strong>{{productName}}</strong> has been everything you hoped for!
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>Final reminder to share your experience!</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                If you haven't already, we'd love to hear your thoughts on Amazon. Your review helps us continue offering quality rewards and helps other customers make informed decisions.
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Write Your Review Now
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Thank you for being part of our community!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

### 5. Admin Routes
#### Create: `routes/admin/feedback.js`
```javascript
const express = require('express');
const router = express.Router();
const FeedbackTracker = require('../../models/FeedbackTracker');
const EmailTemplate = require('../../models/FeedbackTracker').EmailTemplate;

// Middleware to connect to database
const connectToDatabase = require('../../index').connectToDatabase;

// Get all feedback trackers
router.get('/feedback-trackers', async (req, res) => {
  try {
    await connectToDatabase();
    
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const skip = (page - 1) * limit;

    const query = {};
    if (status) {
      query.status = status;
    }
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { customerName: { $regex: search, $options: 'i' } },
        { customerEmail: { $regex: search, $options: 'i' } },
      ];
    }

    const [trackers, total] = await Promise.all([
      FeedbackTracker.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      FeedbackTracker.countDocuments(query),
    ]);

    res.json({
      success: true,
      data: {
        trackers,
        pagination: {
          total,
          page,
          pages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching feedback trackers:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching feedback trackers',
    });
  }
});

// Get feedback tracker by order ID
router.get('/feedback-trackers/:orderId', async (req, res) => {
  try {
    await connectToDatabase();
    
    const tracker = await FeedbackTracker.findOne({ orderId: req.params.orderId });
    
    if (!tracker) {
      return res.status(404).json({
        success: false,
        message: 'Feedback tracker not found',
      });
    }
    
    res.json({
      success: true,
      data: tracker,
    });
  } catch (error) {
    console.error('Error fetching feedback tracker:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching feedback tracker',
    });
  }
});

// Update feedback tracker status
router.patch('/feedback-trackers/:orderId/status', async (req, res) => {
  try {
    await connectToDatabase();
    
    const { status } = req.body;
    const tracker = await FeedbackTracker.findOne({ orderId: req.params.orderId });
    
    if (!tracker) {
      return res.status(404).json({
        success: false,
        message: 'Feedback tracker not found',
      });
    }
    
    if (['pending', 'reviewed', 'unreviewed', 'cancelled'].indexOf(status) === -1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status',
      });
    }
    
    if (status === 'reviewed') {
      await tracker.markAsReviewed();
    } else if (status === 'unreviewed') {
      await tracker.markAsUnreviewed();
    } else if (status === 'cancelled') {
      await tracker.cancelTracking();
    } else {
      tracker.status = status;
      tracker.updatedAt = new Date();
      await tracker.save();
    }
    
    res.json({
      success: true,
      message: 'Status updated successfully',
      data: tracker,
    });
  } catch (error) {
    console.error('Error updating feedback tracker status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating feedback tracker status',
    });
  }
});

// Get email templates
router.get('/email-templates', async (req, res) => {
  try {
    await connectToDatabase();
    
    const templates = await EmailTemplate.find({}).sort({ day: 1 });
    
    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    console.error('Error fetching email templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching email templates',
    });
  }
});

// Create or update email template
router.post('/email-templates', async (req, res) => {
  try {
    await connectToDatabase();
    
    const { day, subject, htmlContent, isActive } = req.body;
    
    // Validate input
    if (!day || !subject || !htmlContent) {
      return res.status(400).json({
        success: false,
        message: 'Day, subject, and HTML content are required',
      });
    }
    
    if (day < 1 || day > 30) {
      return res.status(400).json({
        success: false,
        message: 'Day must be between 1 and 30',
      });
    }
    
    // Check if template already exists
    let template = await EmailTemplate.findOne({ day });
    
    if (template) {
      // Update existing template
      template.subject = subject;
      template.htmlContent = htmlContent;
      template.isActive = isActive !== undefined ? isActive : true;
      template.updatedAt = new Date();
      await template.save();
    } else {
      // Create new template
      template = new EmailTemplate({
        day,
        subject,
        htmlContent,
        isActive: isActive !== undefined ? isActive : true,
      });
      await template.save();
    }
    
    res.json({
      success: true,
      message: 'Template saved successfully',
      data: template,
    });
  } catch (error) {
    console.error('Error saving email template:', error);
    res.status(500).json({
      success: false,
      message: 'Error saving email template',
    });
  }
});

// Get email statistics
router.get('/statistics', async (req, res) => {
  try {
    await connectToDatabase();
    
    const stats = await FeedbackTracker.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);
    
    const totalTrackers = await FeedbackTracker.countDocuments();
    
    // Calculate email statistics
    const emailStats = await FeedbackTracker.aggregate([
      {
        $project: {
          totalEmails: { $literal: 4 }, // 4 emails per tracker (days 3, 7, 14, 30)
          sentEmails: {
            $add: [
              { $cond: [{ $eq: ['$emailSchedule.day3.sent', true] }, 1, 0] },
              { $cond: [{ $eq: ['$emailSchedule.day7.sent', true] }, 1, 0] },
              { $cond: [{ $eq: ['$emailSchedule.day14.sent', true] }, 1, 0] },
              { $cond: [{ $eq: ['$emailSchedule.day30.sent', true] }, 1, 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalEmailsPossible: { $sum: '$totalEmails' },
          totalEmailsSent: { $sum: '$sentEmails' },
        },
      },
    ]);
    
    res.json({
      success: true,
      data: {
        overall: {
          totalTrackers,
          statusBreakdown: stats.reduce((acc, stat) => {
            acc[stat._id] = stat.count;
            return acc;
          }, {}),
        },
        emailPerformance: emailStats[0] ? {
          emailsSent: emailStats[0].totalEmailsSent,
          emailsPossible: emailStats[0].totalEmailsPossible,
          emailRate: emailStats[0].totalEmailsPossible > 0 
            ? Math.round((emailStats[0].totalEmailsSent / emailStats[0].totalEmailsPossible) * 100) 
            : 0,
        } : { emailsSent: 0, emailsPossible: 0, emailRate: 0 },
      },
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching statistics',
    });
  }
});

module.exports = router;
```

### 6. Admin Views
#### Create: `views/admin/feedback-manager.ejs`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Feedback Manager - Study Key</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
</head>
<body>
    <div class="container-fluid">
        <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
            <div class="container">
                <a class="navbar-brand" href="/admin">Study Key Admin</a>
                <div class="navbar-nav ms-auto">
                    <span class="navbar-text">Feedback Manager</span>
                </div>
            </div>
        </nav>

        <div class="container mt-4">
            <!-- Statistics Cards -->
            <div class="row mb-4">
                <div class="col-md-3">
                    <div class="card text-center">
                        <div class="card-body">
                            <h5 class="card-title"><i class="fas fa-users"></i> Total</h5>
                            <h3 class="text-primary"><%= stats.total %></h3>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-center">
                        <div class="card-body">
                            <h5 class="card-title"><i class="fas fa-clock"></i> Pending</h5>
                            <h3 class="text-warning"><%= stats.pending %></h3>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-center">
                        <div class="card-body">
                            <h5 class="card-title"><i class="fas fa-check-circle"></i> Reviewed</h5>
                            <h3 class="text-success"><%= stats.reviewed %></h3>
                        </div>
                    </div>
                </div>
                <div class="col-md-3">
                    <div class="card text-center">
                        <div class="card-body">
                            <h5 class="card-title"><i class="fas fa-times-circle"></i> Unreviewed</h5>
                            <h3 class="text-danger"><%= stats.unreviewed %></h3>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Filters -->
            <div class="card mb-4">
                <div class="card-header">
                    <h5 class="mb-0"><i class="fas fa-filter"></i> Filters</h5>
                </div>
                <div class="card-body">
                    <form method="GET" action="/admin/feedback">
                        <input type="hidden" name="token" value="<%= token %>">
                        <div class="row">
                            <div class="col-md-4">
                                <input type="text" name="search" class="form-control" placeholder="Search by order, name, or email..." value="<%= search %>">
                            </div>
                            <div class="col-md-3">
                                <select name="status" class="form-select">
                                    <option value="">All Status</option>
                                    <option value="pending" <%= status === 'pending' ? 'selected' : '' %>>Pending</option>
                                    <option value="reviewed" <%= status === 'reviewed' ? 'selected' : '' %>>Reviewed</option>
                                    <option value="unreviewed" <%= status === 'unreviewed' ? 'selected' : '' %>>Unreviewed</option>
                                    <option value="cancelled" <%= status === 'cancelled' ? 'selected' : '' %>>Cancelled</option>
                                </select>
                            </div>
                            <div class="col-md-3">
                                <button type="submit" class="btn btn-primary"><i class="fas fa-search"></i> Filter</button>
                                <a href="/admin/feedback?token=<%= token %>" class="btn btn-secondary"><i class="fas fa-refresh"></i> Reset</a>
                            </div>
                        </div>
                    </form>
                </div>
            </div>

            <!-- Trackers Table -->
            <div class="card">
                <div class="card-header d-flex justify-content-between align-items-center">
                    <h5 class="mb-0"><i class="fas fa-list"></i> Feedback Trackers</h5>
                    <a href="/admin/feedback/templates?token=<%= token %>" class="btn btn-outline-primary">
                        <i class="fas fa-envelope"></i> Email Templates
                    </a>
                </div>
                <div class="card-body">
                    <div class="table-responsive">
                        <table class="table table-striped">
                            <thead>
                                <tr>
                                    <th>Order ID</th>
                                    <th>Customer</th>
                                    <th>Email</th>
                                    <th>Product</th>
                                    <th>Status</th>
                                    <th>Created</th>
                                    <th>Email Schedule</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <% trackers.forEach(function(tracker) { %>
                                <tr>
                                    <td><%= tracker.orderId %></td>
                                    <td><%= tracker.customerName %></td>
                                    <td><%= tracker.customerEmail %></td>
                                    <td><%= tracker.productName || 'N/A' %></td>
                                    <td>
                                        <span class="badge 
                                            <%= tracker.status === 'pending' ? 'bg-warning' : 
                                               tracker.status === 'reviewed' ? 'bg-success' : 
                                               tracker.status === 'unreviewed' ? 'bg-danger' : 'bg-secondary' %>">
                                            <%= tracker.status.charAt(0).toUpperCase() + tracker.status.slice(1) %>
                                        </span>
                                    </td>
                                    <td><%= formatDate(tracker.createdAt) %></td>
                                    <td>
                                        <small>
                                            Day 3: <span class="<%= tracker.emailSchedule.day3.sent ? 'text-success' : 'text-muted' %>">
                                                <%= tracker.emailSchedule.day3.sent ? '✓' : '○' %>
                                            </span>
                                            Day 7: <span class="<%= tracker.emailSchedule.day7.sent ? 'text-success' : 'text-muted' %>">
                                                <%= tracker.emailSchedule.day7.sent ? '✓' : '○' %>
                                            </span>
                                            Day 14: <span class="<%= tracker.emailSchedule.day14.sent ? 'text-success' : 'text-muted' %>">
                                                <%= tracker.emailSchedule.day14.sent ? '✓' : '○' %>
                                            </span>
                                            Day 30: <span class="<%= tracker.emailSchedule.day30.sent ? 'text-success' : 'text-muted' %>">
                                                <%= tracker.emailSchedule.day30.sent ? '✓' : '○' %>
                                            </span>
                                        </small>
                                    </td>
                                    <td>
                                        <div class="btn-group btn-group-sm">
                                            <button type="button" class="btn btn-outline-primary dropdown-toggle" data-bs-toggle="dropdown">
                                                Actions
                                            </button>
                                            <ul class="dropdown-menu">
                                                <li><a class="dropdown-item" href="#" onclick="updateStatus('<%= tracker.orderId %>', 'reviewed')">Mark as Reviewed</a></li>
                                                <li><a class="dropdown-item" href="#" onclick="updateStatus('<%= tracker.orderId %>', 'cancelled')">Cancel Tracking</a></li>
                                                <li><hr class="dropdown-divider"></li>
                                                <li><a class="dropdown-item" href="#" onclick="sendTestEmail('<%= tracker.orderId %>')">Send Test Email</a></li>
                                            </ul>
                                        </div>
                                    </td>
                                </tr>
                                <% }); %>
                            </tbody>
                        </table>
                    </div>

                    <!-- Pagination -->
                    <% if (pagination.pages > 1) { %>
                    <nav aria-label="Page navigation">
                        <ul class="pagination justify-content-center">
                            <li class="page-item <%= pagination.page === 1 ? 'disabled' : '' %>">
                                <a class="page-link" href="?page=<%= pagination.page - 1 %>&search=<%= encodeURIComponent(search) %>&status=<%= status %>&token=<%= token %>">Previous</a>
                            </li>
                            
                            <% for (let i = Math.max(1, pagination.page - 2); i <= Math.min(pagination.pages, pagination.page + 2); i++) { %>
                            <li class="page-item <%= i === pagination.page ? 'active' : '' %>">
                                <a class="page-link" href="?page=<%= i %>&search=<%= encodeURIComponent(search) %>&status=<%= status %>&token=<%= token %>"><%= i %></a>
                            </li>
                            <% } %>
                            
                            <li class="page-item <%= pagination.page === pagination.pages ? 'disabled' : '' %>">
                                <a class="page-link" href="?page=<%= pagination.page + 1 %>&search=<%= encodeURIComponent(search) %>&status=<%= status %>&token=<%= token %>">Next</a>
                            </li>
                        </ul>
                    </nav>
                    <% } %>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        async function updateStatus(orderId, status) {
            if (confirm(`Are you sure you want to update status to ${status}?`)) {
                try {
                    const response = await fetch(`/api/admin/feedback-trackers/${orderId}/status`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-Token': '<%= token %>'
                        },
                        body: JSON.stringify({ status })
                    });
                    
                    if (response.ok) {
                        alert('Status updated successfully!');
                        location.reload();
                    } else {
                        alert('Failed to update status');
                    }
                } catch (error) {
                    console.error('Error updating status:', error);
                    alert('Error updating status');
                }
            }
        }
        
        async function sendTestEmail(orderId) {
            try {
                const response = await fetch(`/api/admin/test-email/${orderId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Admin-Token': '<%= token %>'
                    }
                });
                
                const result = await response.json();
                if (result.success) {
                    alert('Test email sent successfully!');
                } else {
                    alert('Failed to send test email: ' + result.message);
                }
            } catch (error) {
                console.error('Error sending test email:', error);
                alert('Error sending test email');
            }
        }
    </script>
</body>
</html>
```

#### Create: `views/admin/email-templates.ejs`
```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Email Templates - Study Key</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
</head>
<body>
    <div class="container-fluid">
        <nav class="navbar navbar-expand-lg navbar-dark bg-primary">
            <div class="container">
                <a class="navbar-brand" href="/admin">Study Key Admin</a>
                <div class="navbar-nav ms-auto">
                    <span class="navbar-text">Email Templates</span>
                </div>
            </div>
        </nav>

        <div class="container mt-4">
            <div class="row">
                <div class="col-md-12">
                    <div class="card">
                        <div class="card-header d-flex justify-content-between align-items-center">
                            <h5 class="mb-0"><i class="fas fa-envelope-open-text"></i> Email Templates</h5>
                            <a href="/admin/feedback?token=<%= token %>" class="btn btn-outline-secondary">
                                <i class="fas fa-arrow-left"></i> Back to Feedback Manager
                            </a>
                        </div>
                        <div class="card-body">
                            <div class="alert alert-info">
                                <i class="fas fa-info-circle"></i> 
                                Use these placeholders in your templates: <code>{{customerName}}</code>, <code>{{productName}}</code>, <code>{{reviewUrl}}</code>, <code>{{productUrl}}</code>
                            </div>
                            
                            <div class="row">
                                <div class="col-md-6">
                                    <h6>Day 3 Template</h6>
                                    <form id="template-form-3">
                                        <input type="hidden" name="day" value="3">
                                        <div class="mb-3">
                                            <label class="form-label">Subject</label>
                                            <input type="text" name="subject" class="form-control" value="{{customerName}}, how's your Study Key product? 🎯">
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">HTML Content</label>
                                            <textarea name="htmlContent" class="form-control" rows="10"><!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, how's your Study Key product?</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 👋</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been 3 days since you claimed your Study Key reward. We hope you're enjoying <strong>{{productName}}</strong>!
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>Would you mind sharing your experience?</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Your honest Amazon review helps us improve and helps other customers make informed decisions. It only takes a minute!
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Write Your Review
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Thank you for being part of our community!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html></textarea>
                                        </div>
                                        <div class="mb-3 form-check">
                                            <input type="checkbox" name="isActive" class="form-check-input" checked>
                                            <label class="form-check-label">Active</label>
                                        </div>
                                        <button type="submit" class="btn btn-primary">Save Template</button>
                                    </form>
                                </div>
                                
                                <div class="col-md-6">
                                    <h6>Day 7 Template</h6>
                                    <form id="template-form-7">
                                        <input type="hidden" name="day" value="7">
                                        <div class="mb-3">
                                            <label class="form-label">Subject</label>
                                            <input type="text" name="subject" class="form-control" value="{{customerName}}, share your Study Key experience? 📝">
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">HTML Content</label>
                                            <textarea name="htmlContent" class="form-control" rows="10"><!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, share your Study Key experience?</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <input type="text" name="subject" class="form-control" value="{{customerName}}, your feedback matters to us! 💭">
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">HTML Content</label>
                                            <textarea name="htmlContent" class="form-control" rows="10"><!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, your feedback matters!</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 💭</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been 2 weeks since you received your Study Key product. We hope <strong>{{productName}}</strong> continues to meet your expectations!
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>Your feedback really matters to us and other customers.</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Taking a moment to leave an Amazon review helps us understand what we're doing right and where we can improve. Plus, it guides other customers in their purchasing decisions.
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Share Your Thoughts
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Thank you for taking the time to help us grow!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html></textarea>
                                        </div>
                                        <div class="mb-3 form-check">
                                            <input type="checkbox" name="isActive" class="form-check-input" checked>
                                            <label class="form-check-label">Active</label>
                                        </div>
                                        <button type="submit" class="btn btn-primary">Save Template</button>
                                    </form>
                                </div>
                                
                                <div class="col-md-6">
                                    <h6>Day 30 Template</h6>
                                    <form id="template-form-30">
                                        <input type="hidden" name="day" value="30">
                                        <div class="mb-3">
                                            <label class="form-label">Subject</label>
                                            <input type="text" name="subject" class="form-control" value="Final reminder: Share your Study Key review 🌟">
                                        </div>
                                        <div class="mb-3">
                                            <label class="form-label">HTML Content</label>
                                            <textarea name="htmlContent" class="form-control" rows="10"><!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{customerName}}, final review reminder</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #f4f4f4;">
    <tr>
      <td style="padding: 20px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center" style="background-color: #ffffff; border-radius: 8px;">
          <!-- Header -->
          <tr>
            <td style="padding: 30px 30px 20px 30px; text-align: center;">
              <h1 style="color: #333333; margin: 0; font-size: 24px;">Hi {{customerName}}! 🌟</h1>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 30px 20px 30px;">
              <p style="margin: 0 0 15px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                It's been a month since you received your Study Key product. We hope <strong>{{productName}}</strong> has been everything you hoped for!
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                <strong>Final reminder to share your experience!</strong>
              </p>
              
              <p style="margin: 0 0 30px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                If you haven't already, we'd love to hear your thoughts on Amazon. Your review helps us continue offering quality rewards and helps other customers make informed decisions.
              </p>
              
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 30px auto;">
                <tr>
                  <td style="border-radius: 5px; background-color: #FF9900;">
                    <a href="{{reviewUrl}}" target="_blank" style="display: inline-block; padding: 15px 30px; font-family: Arial, sans-serif; font-size: 16px; color: #ffffff; text-decoration: none; font-weight: bold;">
                      Write Your Review Now
                    </a>
                  </td>
                </tr>
              </table>
              
              {{#if productUrl}}
              <p style="margin: 0 0 20px 0; text-align: center;">
                <a href="{{productUrl}}" target="_blank" style="color: #0066c0; text-decoration: none; font-size: 14px;">View {{productName}} on Amazon</a>
              </p>
              {{/if}}
              
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #555555; line-height: 1.5;">
                Thank you for being part of our community!
              </p>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 20px 30px; text-align: center; background-color: #f9f9f9; border-top: 1px solid #dddddd; font-size: 12px; color: #666666;">
              <p style="margin: 0;">
                You're receiving this because you claimed a Study Key reward. If you've already left a review, thank you! You can ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html></textarea>
                                        </div>
                                        <div class="mb-3 form-check">
                                            <input type="checkbox" name="isActive" class="form-check-input" checked>
                                            <label class="form-check-label">Active</label>
                                        </div>
                                        <button type="submit" class="btn btn-primary">Save Template</button>
                                    </form>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
    <script>
        document.querySelectorAll('form[id^="template-form-"]').forEach(form => {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                
                const formData = new FormData(e.target);
                const data = Object.fromEntries(formData);
                data.isActive = formData.get('isActive') === 'on';
                
                try {
                    const response = await fetch('/api/admin/email-templates', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Admin-Token': '<%= token %>'
                        },
                        body: JSON.stringify(data)
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        alert('Template saved successfully!');
                    } else {
                        alert('Failed to save template: ' + result.message);
                    }
                } catch (error) {
                    console.error('Error saving template:', error);
                    alert('Error saving template');
                }
            });
        });
    </script>
</body>
</html>