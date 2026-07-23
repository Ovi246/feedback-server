const express = require("express");
const geoip = require("fast-geoip");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const SellingPartnerAPI = require("amazon-sp-api");
const path = require("path");

const app = express();
require("dotenv").config();
app.use(express.json({ limit: "10kb" }));

const cors = require("cors");
const allowedOrigins = [
  // Allow origins from env only.
  ...(process.env.RIDDLES_ORIGIN ? [process.env.RIDDLES_ORIGIN] : []),
  ...(process.env.GIVEAWAY_ORIGIN ? [process.env.GIVEAWAY_ORIGIN] : []),
  ...(process.env.RIDDLES_SERVER_ORIGIN ? [process.env.RIDDLES_SERVER_ORIGIN] : []),
  ...(process.env.WORKBOOK_ORIGIN ? [process.env.WORKBOOK_ORIGIN] : []),
  // Optional extra origins, comma-separated
  ...(process.env.EXTRA_ALLOWED_ORIGINS
    ? process.env.EXTRA_ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []),
  // Optional single consolidated list, comma-separated
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : []),
  // "http://localhost:5173",
  // // "http://localhost:5000",
];

const nodemailer = require("nodemailer");
const createDOMPurify = require("dompurify");
const { JSDOM } = require("jsdom");
const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window);

const mongoose = require("mongoose");

// MongoDB connection optimization
let cachedConnection = null;

async function connectToDatabase() {
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection;
  }

  mongoose.connection.on('connected', () => console.log('MongoDB connected'));
  mongoose.connection.on('error', (err) => console.error('MongoDB connection error:', err));

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
      maxPoolSize: 10,
      family: 4
    });

    cachedConnection = conn;
    return conn;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

(async () => {
  try {
    await connectToDatabase();
    console.log('Connected to MongoDB at startup');
  } catch (err) {
    console.error('Failed to connect to MongoDB at startup:', err);
  }
})();

// Separate connection for the "newemailonly" database (holds the `workbook` and
// `ebook` collections). Kept independent from the default connection so the
// bonus/feedback routes are unaffected.
let cachedEmailConnection = null;

async function connectToEmailDatabase() {
  if (cachedEmailConnection && cachedEmailConnection.readyState === 1) {
    return cachedEmailConnection;
  }

  if (!process.env.EMAIL_MONGODB_URI) {
    throw new Error("EMAIL_MONGODB_URI is not configured");
  }

  const conn = mongoose.createConnection(process.env.EMAIL_MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 30000,
    maxPoolSize: 10,
    family: 4,
  });

  conn.on("connected", () => console.log("Email MongoDB connected"));
  conn.on("error", (err) => console.error("Email MongoDB connection error:", err));

  await conn.asPromise();
  cachedEmailConnection = conn;
  return conn;
}

const Schema = mongoose.Schema;

// --- Email validation / normalization (shared, server-side; clients are untrusted) ---
const EMAIL_MAX_LENGTH = 254; // RFC 5321 total length cap
const EMAIL_REGEX = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null; // rejects arrays/objects → blocks NoSQL operator injection
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) return null;
  return email;
}

function isValidEmail(email) {
  if (typeof email !== "string" || !EMAIL_REGEX.test(email)) return false;
  const [local, domain] = email.split("@");
  return local.length <= 64 && domain.length <= 255;
}

// Turn a Google Drive "view" link into a direct-download link (leaves other URLs untouched).
function toDriveDownloadUrl(url) {
  if (typeof url !== "string") return url;
  const match = /\/file\/d\/([^/]+)/.exec(url) || /[?&]id=([^&]+)/.exec(url);
  return match ? `https://drive.google.com/uc?export=download&id=${match[1]}` : url;
}

const handlebars = require("nodemailer-express-handlebars");

let transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

transporter.use(
  "compile",
  handlebars({
    viewEngine: {
      extName: ".html",
      partialsDir: path.join(__dirname, "views/email"),
      layoutsDir: path.join(__dirname, "views/email"),
      defaultLayout: false,
    },
    viewPath: path.join(__dirname, "views/email"),
    extName: ".html",
  })
);

// Promisified mail send so we can `await` delivery (important on serverless:
// un-awaited sends can be dropped when the function freezes after responding).
function sendMailPromise(options) {
  return new Promise((resolve, reject) => {
    transporter.sendMail(options, (error, info) => {
      if (error) reject(error);
      else resolve(info);
    });
  });
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.set('trust proxy', 1);

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
});

app.use(limiter);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.indexOf(origin) === -1) {
        var msg =
          "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
  })
);

let sellingPartner;
try {
  sellingPartner = new SellingPartnerAPI({
    region: "na",
    refresh_token: process.env.REFRESH_TOKEN,
    options: {
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: process.env.SELLING_PARTNER_APP_CLIENT_ID,
        SELLING_PARTNER_APP_CLIENT_SECRET:
          process.env.SELLING_PARTNER_APP_CLIENT_SECRET,
      },
    },
  });
} catch (error) {
  console.warn('⚠️  WARNING: Amazon SP API credentials not found. Order validation may not work properly.');
  console.warn('Error:', error.message);
  sellingPartner = null;
}

app.post("/validate-order-id", async (req, res) => {
  const { orderId } = req.body;

  if (!sellingPartner) {
    return res.status(500).send({
      error: "Amazon SP API is not configured properly. Please contact the administrator."
    });
  }

  try {
    const order = await sellingPartner.callAPI({
      operation: "getOrder",
      endpoint: "orders",
      path: { orderId: orderId },
    });

    if (Object.keys(order).length > 0) {
      const orderItems = await sellingPartner.callAPI({
        operation: "getOrderItems",
        endpoint: "orders",
        path: { orderId: orderId },
      });

      const asins = orderItems.OrderItems.map((item) => item.ASIN);
      res.status(200).send({ valid: true, asin: asins });
    } else {
      res.status(400).send({ valid: false });
    }
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .send({ error: "An error occurred while validating the order ID" });
  }
});

app.get("/", async (req, res) => {
  res.status(200).send("api running");
});

app.get("/api/location", async (req, res) => {
  const ip = req.ip || "127.0.0.1";
  const geo = await geoip.lookup(ip);
  res.send(geo);
});

const authenticateAdmin = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

const BonusSchema = new Schema({
  firstName: String,
  lastName: String,
  language: String,
  email: String,
  orderId: { type: String, unique: true },
  phoneNumber: String,
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  createdAt: { type: Date, default: Date.now }
});

let Bonus;
if (mongoose.models.Bonus) {
  Bonus = mongoose.model("Bonus");
} else {
  Bonus = mongoose.model("Bonus", BonusSchema);
}

// Admin route for viewing bonus claims
app.get("/admin/bonus", authenticateAdmin, async (req, res) => {
  try {
    await connectToDatabase();

    const {
      startDate,
      endDate,
      language,
      searchTerm,
      zipCode,
      city,
      state,
      page = 1,
      limit = 10
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let filter = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);

      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);

      filter.createdAt = {
        $gte: start,
        $lte: end
      };
    } else if (startDate) {
      const start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);
      filter.createdAt = { $gte: start };
    } else if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      filter.createdAt = { $lte: end };
    }

    if (language) {
      filter.language = language;
    }

    if (zipCode) {
      filter['address.zipCode'] = zipCode;
    }
    if (city) {
      filter['address.city'] = { $regex: city, $options: 'i' };
    }
    if (state) {
      filter['address.state'] = { $regex: state, $options: 'i' };
    }

    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } },
        { orderId: { $regex: searchTerm, $options: 'i' } },
        { 'address.street': { $regex: searchTerm, $options: 'i' } },
        { 'address.city': { $regex: searchTerm, $options: 'i' } },
        { 'address.state': { $regex: searchTerm, $options: 'i' } },
        { 'address.zipCode': { $regex: searchTerm, $options: 'i' } }
      ];
    }

    let total;
    let bonuses;

    try {
      total = await Bonus.countDocuments(filter);
      bonuses = await Bonus.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean()
        .exec();
    } catch (dbError) {
      console.error("Database query error:", dbError);
      return res.status(500).json({
        success: false,
        message: "Database error: " + dbError.message
      });
    }

    const totalPages = Math.ceil(total / limitNum);

    let rows = bonuses.map(bonus => {
      const date = bonus.createdAt ? new Date(bonus.createdAt).toLocaleDateString() : 'N/A';
      return '<tr>' +
        '<td>' + (bonus.firstName || '-') + ' ' + (bonus.lastName || '-') + '</td>' +
        '<td>' + (bonus.email || '-') + '</td>' +
        '<td>' + (bonus.orderId || '-') + '</td>' +
        '<td>' + (bonus.language || '-') + '</td>' +
        '<td>' + (bonus.address?.street || '-') + '</td>' +
        '<td>' + (bonus.address?.city || '-') + '</td>' +
        '<td>' + (bonus.address?.state || '-') + '</td>' +
        '<td>' + (bonus.address?.zipCode || '-') + '</td>' +
        '<td>' + date + '</td>' +
        '</tr>';
    }).join('');

    let paginationHTML = '';
    if (totalPages > 1) {
      paginationHTML += `<li class="page-item ${pageNum <= 1 ? 'disabled' : ''}">
        <a class="page-link" href="?token=${req.query.token}&page=${pageNum - 1}${startDate ? '&startDate=' + startDate : ''}${endDate ? '&endDate=' + endDate : ''}${language ? '&language=' + language : ''}${searchTerm ? '&searchTerm=' + searchTerm : ''}${zipCode ? '&zipCode=' + zipCode : ''}${city ? '&city=' + city : ''}${state ? '&state=' + state : ''}">Previous</a>
      </li>`;

      const startPage = Math.max(1, pageNum - 2);
      const endPage = Math.min(totalPages, pageNum + 2);

      for (let i = startPage; i <= endPage; i++) {
        paginationHTML += `<li class="page-item ${i === pageNum ? 'active' : ''}">
          <a class="page-link" href="?token=${req.query.token}&page=${i}${startDate ? '&startDate=' + startDate : ''}${endDate ? '&endDate=' + endDate : ''}${language ? '&language=' + language : ''}${searchTerm ? '&searchTerm=' + searchTerm : ''}${zipCode ? '&zipCode=' + zipCode : ''}${city ? '&city=' + city : ''}${state ? '&state=' + state : ''}">${i}</a>
        </li>`;
      }

      paginationHTML += `<li class="page-item ${pageNum >= totalPages ? 'disabled' : ''}">
        <a class="page-link" href="?token=${req.query.token}&page=${pageNum + 1}${startDate ? '&startDate=' + startDate : ''}${endDate ? '&endDate=' + endDate : ''}${language ? '&language=' + language : ''}${searchTerm ? '&searchTerm=' + searchTerm : ''}${zipCode ? '&zipCode=' + zipCode : ''}${city ? '&city=' + city : ''}${state ? '&state=' + state : ''}">Next</a>
      </li>`;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bonus Claims Dashboard</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha1/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
          body { padding: 20px; }
          .filters { margin-bottom: 20px; }
          table { width: 100%; }
          th, td { padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          .pagination { justify-content: center; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1 class="mb-4">Study Key - Bonus Claims Management</h1>
          <div class="alert alert-info">Total Bonus Claims: ${total} (Page ${pageNum} of ${totalPages})</div>

          <form method="GET" action="/admin/bonus" class="filters row g-3">
            <input type="hidden" name="token" value="${req.query.token}">

            <div class="col-md-3">
              <label class="form-label">Start Date</label>
              <input type="date" class="form-control" name="startDate" value="${startDate || ''}">
            </div>
            <div class="col-md-3">
              <label class="form-label">End Date</label>
              <input type="date" class="form-control" name="endDate" value="${endDate || ''}">
            </div>
            <div class="col-md-3">
              <label class="form-label">Language</label>
              <select class="form-select" name="language">
                <option value="" ${!language ? 'selected' : ''}>All Languages</option>
                <option value="English" ${language === 'English' ? 'selected' : ''}>English</option>
                <option value="Spanish" ${language === 'Spanish' ? 'selected' : ''}>Spanish</option>
              </select>
            </div>
            <div class="col-md-3">
              <label class="form-label">Zip Code</label>
              <input type="text" class="form-control" name="zipCode" value="${zipCode || ''}" placeholder="Zip Code">
            </div>
            <div class="col-md-3">
              <label class="form-label">City</label>
              <input type="text" class="form-control" name="city" value="${city || ''}" placeholder="City">
            </div>
            <div class="col-md-3">
              <label class="form-label">State</label>
              <input type="text" class="form-control" name="state" value="${state || ''}" placeholder="State">
            </div>
            <div class="col-md-3">
              <label class="form-label">Search</label>
              <input type="text" class="form-control" name="searchTerm" value="${searchTerm || ''}" placeholder="Name, Email, Order ID, or Address">
            </div>

            <div class="col-12 mt-3">
              <button type="submit" class="btn btn-primary">Apply Filters</button>
              <a href="/admin/bonus?token=${req.query.token}" class="btn btn-secondary ms-2">Reset Filters</a>
              <a href="/admin/bonus/csv?token=${req.query.token}${startDate ? '&startDate=' + startDate : ''}${endDate ? '&endDate=' + endDate : ''}${language ? '&language=' + language : ''}${searchTerm ? '&searchTerm=' + searchTerm : ''}${zipCode ? '&zipCode=' + zipCode : ''}${city ? '&city=' + city : ''}${state ? '&state=' + state : ''}" class="btn btn-success ms-2">Download CSV</a>
            </div>
          </form>

          <div class="table-responsive">
            <table class="table table-striped">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Order ID</th>
                  <th>Language</th>
                  <th>Street</th>
                  <th>City</th>
                  <th>State</th>
                  <th>Zip Code</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length ? rows : '<tr><td colspan="10" class="text-center">No bonus claims found</td></tr>'}
              </tbody>
            </table>
          </div>

          <nav aria-label="Page navigation">
            <ul class="pagination">
              ${paginationHTML}
            </ul>
          </nav>
        </div>
      </body>
      </html>
    `;

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
  } catch (err) {
    console.error("Error rendering bonus admin page:", err);
    res.status(500).json({ success: false, message: "Error: " + err.message });
  }
});

app.get("/admin/bonus/csv", authenticateAdmin, async (req, res) => {
  try {
    await connectToDatabase();

    const { startDate, endDate, language, searchTerm, zipCode, city, state } = req.query;

    let filter = {};

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);

      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);

      filter.createdAt = {
        $gte: start,
        $lte: end
      };
    } else if (startDate) {
      const start = new Date(startDate);
      start.setUTCHours(0, 0, 0, 0);
      filter.createdAt = { $gte: start };
    } else if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      filter.createdAt = { $lte: end };
    }

    if (language) filter.language = language;
    if (zipCode) filter['address.zipCode'] = zipCode;
    if (city) filter['address.city'] = { $regex: city, $options: 'i' };
    if (state) filter['address.state'] = { $regex: state, $options: 'i' };

    if (searchTerm) {
      filter.$or = [
        { name: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } },
        { orderId: { $regex: searchTerm, $options: 'i' } },
        { 'address.street': { $regex: searchTerm, $options: 'i' } },
        { 'address.city': { $regex: searchTerm, $options: 'i' } },
        { 'address.state': { $regex: searchTerm, $options: 'i' } },
        { 'address.zipCode': { $regex: searchTerm, $options: 'i' } }
      ];
    }

    const bonuses = await Bonus.find(filter).sort({ createdAt: -1 }).lean().exec();

    let csv = 'Name,Email,Order ID,Language,Phone,Street,City,State,Zip Code,Created Date\n';
    bonuses.forEach(bonus => {
      const date = bonus.createdAt ? new Date(bonus.createdAt).toISOString().split('T')[0] : 'N/A';
      csv += `"${bonus.firstName || ''} ${bonus.lastName || ''}","${bonus.email || ''}","${bonus.orderId || ''}","${bonus.language || ''}","${bonus.phoneNumber || ''}","${bonus.address?.street || ''}","${bonus.address?.city || ''}","${bonus.address?.state || ''}","${bonus.address?.zipCode || ''}","${date}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=bonus_claims.csv');
    res.status(200).send(csv);
  } catch (err) {
    console.error("Error downloading bonus CSV:", err);
    res.status(500).json({ success: false, message: "Error: " + err.message });
  }
});

app.post("/bonus-claim", async (req, res) => {
  const formData = req.body;

  if (!formData) {
    return res.status(400).json({
      success: false,
      message: "Invalid form data"
    });
  }

  try {
    await connectToDatabase();

    const existingClaim = await Bonus.findOne({ orderId: formData.orderId });
    if (existingClaim) {
      return res.status(409).json({
        success: false,
        message: "This order has already claimed a bonus set."
      });
    }

    const bonus = new Bonus({
      firstName: formData.firstName,
      lastName: formData.lastName,
      language: formData.language,
      email: formData.email,
      orderId: formData.orderId,
      phoneNumber: formData.phoneNumber,
      address: {
        street: formData.address?.street,
        city: formData.address?.city,
        state: formData.address?.state,
        zipCode: formData.address?.zipCode,
        country: formData.address?.country
      },
      createdAt: new Date()
    });

    await bonus.save();

    let userMailOptions = {
      from: process.env.GMAIL_USER,
      to: formData.email,
      subject: "Study Key Bonus Set - Order Confirmation",
      template: "bonus_confirmation",
      context: {
        firstName: formData.firstName,
        lastName: formData.lastName,
        fullName: `${formData.firstName} ${formData.lastName}`,
        orderId: formData.orderId,
        address: formData.address
      },
    };

    let adminMailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: "New Bonus Set Claim",
      html: DOMPurify.sanitize(`
        <h1>New Bonus Set Claim</h1>
        <p><strong>User Name:</strong> ${formData.firstName} ${formData.lastName}</p>
        <p><strong>Email:</strong> ${formData.email}</p>
        <p><strong>Phone:</strong> ${formData.phoneNumber || ''}</p>
        <p><strong>Amazon Order ID:</strong> ${formData.orderId}</p>
        <p><strong>Language:</strong> ${formData.language}</p>
        <p><strong>Address:</strong></p>
        <p>${formData.address?.street || ''}</p>
        <p>${formData.address?.city || ''}, ${formData.address?.state || ''} ${formData.address?.zipCode || ''}</p>
        <p>${formData.address?.country || ''}</p>
      `),
    };

    await Promise.all([
      new Promise((resolve, reject) => {
        transporter.sendMail(userMailOptions, (error, info) => {
          if (error) {
            console.error("Error sending email to user:", error);
            reject(error);
          } else {
            console.log("Email sent to user:", info);
            resolve(info);
          }
        });
      }),
      new Promise((resolve, reject) => {
        transporter.sendMail(adminMailOptions, (error, info) => {
          if (error) {
            console.error("Error sending email to admin:", error);
            reject(error);
          } else {
            console.log("Email sent to admin:", info);
            resolve(info);
          }
        });
      })
    ]);

    res.status(200).json({
      success: true,
      message: "Bonus claim received. A confirmation email has been sent and your order is being processed for shipment."
    });

  } catch (err) {
    console.error("Error in bonus-claim:", err);
    res.status(500).json({
      success: false,
      message: "Error: " + err.message
    });
  }
});

// ---------------------------------------------------------------------------
// Workbook — email subscribe + PDF delivery
// Frontend sends: POST /api/subscribe { email, website(honeypot) }
// Stored in the `workbook` collection of the newemailonly database.
// ---------------------------------------------------------------------------

const SubscriberSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    ipAddress: String,
    userAgent: String,
    lastSentAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "workbook" } // explicit collection name
);

// Model is bound to the email-database connection (compiled once).
function getSubscriberModel(conn) {
  return conn.models.Subscriber || conn.model("Subscriber", SubscriberSchema);
}

// Stricter limiter for the public subscribe endpoint (on top of the global limiter).
const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many requests. Please try again later." },
});

async function sendWorkbookEmail(email) {
  const pdfViewUrl = process.env.WORKBOOK_PDF_URL || "";
  const pdfDownloadUrl = toDriveDownloadUrl(pdfViewUrl);

  const userMailOptions = {
    from: process.env.GMAIL_USER,
    to: email,
    subject: "Your Study Key Workbook is here 📚",
    template: "workbook",
    context: { pdfViewUrl, pdfDownloadUrl },
  };

  const adminMailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.ADMIN_EMAIL || process.env.GMAIL_USER,
    subject: "New Workbook Subscriber",
    html: DOMPurify.sanitize(
      `<h1>New Workbook Subscriber</h1><p><strong>Email:</strong> ${email}</p>`
    ),
  };

  // Send both concurrently and WAIT for both so the admin email actually goes out
  // before the (serverless) function freezes. Admin failure is logged but non-fatal.
  const [userResult, adminResult] = await Promise.allSettled([
    sendMailPromise(userMailOptions),
    sendMailPromise(adminMailOptions),
  ]);

  if (adminResult.status === "rejected") {
    console.error("Admin notification failed (non-fatal):", adminResult.reason);
  } else {
    console.log("Admin notification sent:", adminResult.value && adminResult.value.messageId);
  }

  // The user email is the deliverable — fail the request only if it didn't send.
  if (userResult.status === "rejected") throw userResult.reason;
  console.log("Workbook email sent to user:", userResult.value && userResult.value.messageId);
}

app.post("/api/subscribe", subscribeLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot: real users never fill the hidden "website" field. Silently accept + drop.
    if (body.website !== undefined && String(body.website).trim() !== "") {
      return res.status(200).json({
        success: true,
        message: "Thanks! Check your inbox for your workbook.",
      });
    }

    const email = normalizeEmail(body.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    const conn = await connectToEmailDatabase();
    const Subscriber = getSubscriberModel(conn);

    // Atomic upsert — records new subscribers, refreshes lastSentAt on repeats,
    // and avoids duplicate-key races. Every valid request still gets the PDF.
    try {
      await Subscriber.updateOne(
        { email },
        {
          $setOnInsert: { email, createdAt: new Date() },
          $set: {
            lastSentAt: new Date(),
            ipAddress: req.ip,
            userAgent: req.get("user-agent") || "",
          },
        },
        { upsert: true }
      );
    } catch (dbErr) {
      // 11000 = duplicate key from a concurrent insert; treat as an existing subscriber.
      if (dbErr && dbErr.code !== 11000) throw dbErr;
    }

    await sendWorkbookEmail(email);

    return res.status(200).json({
      success: true,
      message: "Success! Your workbook download link is on its way to your inbox.",
    });
  } catch (err) {
    console.error("Error in /api/subscribe:", err);
    // Generic message — never leak internals to the client.
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again in a moment.",
    });
  }
});

// ---------------------------------------------------------------------------
// eBook — request a PDF by language (called from the giveaway frontend)
// Frontend sends: POST /request-pdf { email, pdf: "English" | "Spanish", website(honeypot) }
// Saved to the `ebook` collection — a DIFFERENT collection in the SAME newemailonly database.
// ---------------------------------------------------------------------------

// Language -> server-owned PDF. The client NEVER supplies a URL, only the key.
const PDF_BY_LANGUAGE = Object.freeze({
  English: { subject: "Your Study Key English eBook 📚", url: process.env.ENGLISH_PDF_URL },
  Spanish: { subject: "Your Study Key Spanish eBook 📚", url: process.env.SPANISH_PDF_URL },
});

const PdfRequestSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    pdf: { type: String, enum: ["English", "Spanish"], required: true },
    ipAddress: String,
    userAgent: String,
    lastSentAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "ebook" } // explicit collection name
);
// One row per (email, language).
PdfRequestSchema.index({ email: 1, pdf: 1 }, { unique: true });

function getPdfRequestModel(conn) {
  return conn.models.PdfRequest || conn.model("PdfRequest", PdfRequestSchema);
}

async function sendPdfEmail(email, language, chosen) {
  const pdfViewUrl = chosen.url || "";
  const pdfDownloadUrl = toDriveDownloadUrl(pdfViewUrl);

  const userMailOptions = {
    from: process.env.GMAIL_USER,
    to: email, // structured field only — no raw headers, so header injection is impossible
    subject: chosen.subject,
    template: "workbook", // reuse the workbook template
    context: { pdfViewUrl, pdfDownloadUrl },
  };

  const adminMailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.ADMIN_EMAIL || process.env.GMAIL_USER,
    subject: `New ${language} eBook request`,
    html: DOMPurify.sanitize(
      `<h1>New eBook request</h1><p><strong>Email:</strong> ${email}</p><p><strong>Language:</strong> ${language}</p>`
    ),
  };

  // Send both concurrently and WAIT for both so the admin email actually goes out
  // before the (serverless) function freezes. Admin failure is logged but non-fatal.
  const [userResult, adminResult] = await Promise.allSettled([
    sendMailPromise(userMailOptions),
    sendMailPromise(adminMailOptions),
  ]);

  if (adminResult.status === "rejected") {
    console.error("Admin notification failed (non-fatal):", adminResult.reason);
  } else {
    console.log("Admin notification sent:", adminResult.value && adminResult.value.messageId);
  }

  if (userResult.status === "rejected") throw userResult.reason;
  console.log("eBook email sent to user:", userResult.value && userResult.value.messageId);
}

app.post("/request-pdf", subscribeLimiter, async (req, res) => {
  try {
    // Only accept JSON (the UI has dedicated copy for a 415).
    if (!req.is("application/json")) {
      return res.status(415).json({ message: "Unsupported content type." });
    }

    const body = req.body || {};

    // Honeypot: real users leave the hidden "website" field empty.
    if (body.website !== undefined && String(body.website).trim() !== "") {
      return res.status(200).json({ ok: true });
    }

    const email = normalizeEmail(body.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }

    // Strict allow-list: pdf must be exactly "English" or "Spanish". Used only as a
    // lookup key, never interpolated into a query/path/filename.
    const chosen = typeof body.pdf === "string" ? PDF_BY_LANGUAGE[body.pdf] : null;
    if (!chosen) {
      return res.status(400).json({ message: "Please choose English or Spanish." });
    }

    const conn = await connectToEmailDatabase();
    const PdfRequest = getPdfRequestModel(conn);

    try {
      await PdfRequest.updateOne(
        { email, pdf: body.pdf },
        {
          $setOnInsert: { email, pdf: body.pdf, createdAt: new Date() },
          $set: {
            lastSentAt: new Date(),
            ipAddress: req.ip,
            userAgent: req.get("user-agent") || "",
          },
        },
        { upsert: true }
      );
    } catch (dbErr) {
      if (dbErr && dbErr.code !== 11000) throw dbErr;
    }

    await sendPdfEmail(email, body.pdf, chosen);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Error in /request-pdf:", err);
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  }
});

// app.listen(process.env.PORT || 5000, () => {
//   console.log(`Server is running on port ${process.env.PORT || 3000}`);
// });

module.exports = app;
module.exports.connectToDatabase = connectToDatabase;
module.exports.connectToEmailDatabase = connectToEmailDatabase;
