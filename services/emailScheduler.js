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
  console.log(`\n📧 Sending Day ${dayNumber} email to ${tracker.orderId} for ${tracker.customerEmail}`);
  
  try {
    // Check for SendGrid configuration
    if (!process.env.SENDGRID_API_KEY) {
      const error = 'SendGrid API key not configured';
      console.error(`❌ ${error}`);
      tracker.emailSchedule[`day${dayNumber}`].error = error;
      await tracker.save();
      return { success: false, error: error };
    }
    
    console.log(`📋 Loading template and subject for Day ${dayNumber}`);
    
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
    
    console.log(`📤 Preparing to send email to: ${tracker.customerEmail}`);
    console.log(`📝 Subject: ${subject.substring(0, 60)}...`);
    
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
    
    console.log(`🚀 Attempting to send email via SendGrid...`);
    const response = await sgMail.send(msg);
    
    // Check response status (202 = accepted)
    if (response[0].statusCode === 202) {
      console.log(`✅ Day ${dayNumber} email successfully sent to ${tracker.customerEmail}`);
      
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
    console.error(`\n❌ FAILED to send Day ${dayNumber} email to ${tracker.customerEmail}!`);
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
  console.log('\n=== EMAIL PROCESSING STARTED ===');
  console.log('Time:', new Date().toISOString());
  
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
    console.log('🔍 Querying for pending email trackers...');
    
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
    
    console.log(`📊 Found ${trackers.length} trackers with pending emails for today`);
    if (trackers.length > 0) {
      console.log('Processing trackers:', trackers.map(t => ({
        orderId: t.orderId,
        email: t.customerEmail,
        scheduledDates: {
          day3: t.emailSchedule.day3.scheduledDate,
          day7: t.emailSchedule.day7.scheduledDate,
          day14: t.emailSchedule.day14.scheduledDate,
          day30: t.emailSchedule.day30.scheduledDate
        }
      })));
    }
    
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
    
    console.log('=== EMAIL PROCESSING COMPLETED ===\n');
    
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