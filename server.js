// server.js (Node + Express)
const express = require('express');
const bodyParser = require('body-parser');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { ethers } = require('ethers');

const app = express();
app.use(bodyParser.json());

// Config via env
const OWNER_EMAIL = 'neandrthal@proton.me';
const ETH_ADDRESS = '0x96d069092c998bB6d75a4863a99D8c1101065915'.toLowerCase();
const BTC_ADDRESS = 'bc1qmtpvy09pytdxfs8ewcvzjvzcx3ktkjzdjytxhu'; // used for info only
const SOL_ADDRESS = '2Wnx3wpfJPrJAzYUfQGbT6m4yFMTBCz2qzP9ssTN92jV';

// SMTP config (use env vars)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// Simple SQLite DB (orders table)
const db = new Database('./weeb-orders.db');
db.prepare(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  email TEXT,
  coin TEXT,
  tx TEXT,
  projectJSON TEXT,
  status TEXT,
  createdAt INTEGER,
  approveToken TEXT,
  verifyCode TEXT,
  verifiedAt INTEGER
)`).run();

// helper: send admin notification with approve link
async function sendAdminApprovalEmail(order) {
  const approveToken = order.approveToken;
  const approveUrl = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/admin/approve?orderId=${order.id}&token=${approveToken}`;
  const mailOpts = {
    from: process.env.EMAIL_FROM || `Weeb <no-reply@yourdomain.com>`,
    to: OWNER_EMAIL,
    subject: `Weeb: Verify crypto payment (${order.coin})`,
    html: `<p>New crypto payment pending:</p>
           <ul>
             <li>Order: ${order.id}</li>
             <li>Coin: ${order.coin}</li>
             <li>TX: ${order.tx}</li>
             <li>User email: ${order.email}</li>
           </ul>
           <p><a href="${approveUrl}">Click to approve and send verification to user</a></p>`
  };
  await transporter.sendMail(mailOpts);
}

// helper: send user verification email
async function sendUserVerificationEmail(order) {
  const verifyCode = order.verifyCode;
  const verifyUrl = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/verify?orderId=${order.id}&code=${verifyCode}`;
  const mailOpts = {
    from: process.env.EMAIL_FROM || `Weeb <no-reply@yourdomain.com>`,
    to: order.email,
    subject: `Weeb: Verify your purchase`,
    html: `<p>Thanks — your payment has been approved by the owner.</p>
           <p>Click to verify your email and download: <a href="${verifyUrl}">VERIFY and download</a></p>
           <p>Or use this code: <strong>${verifyCode}</strong></p>`
  };
  await transporter.sendMail(mailOpts);
}

// Simple API: create crypto purchase record
app.post('/api/crypto-purchase', async (req, res) => {
  try {
    const { email, coin, tx, project } = req.body;
    if (!email || !coin || !tx) return res.status(400).json({ message: 'Missing fields' });

    const id = crypto.randomBytes(12).toString('hex');
    const approveToken = crypto.randomBytes(24).toString('hex');
    const createdAt = Date.now();

    db.prepare(`INSERT INTO orders (id,email,coin,tx,projectJSON,status,createdAt,approveToken) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, email, coin, tx, JSON.stringify(project||{}), 'pending', createdAt, approveToken);

    const order = { id, email, coin, tx, project, approveToken };

    // Notify the owner (neandrthal@proton.me)
    await sendAdminApprovalEmail(order);

    res.json({ id, message: 'Order submitted, owner has been notified.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin approve endpoint (owner clicks link in their email)
app.get('/admin/approve', async (req, res) => {
  const { orderId, token } = req.query;
  if (!orderId || !token) return res.status(400).send('Missing params');

  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!row) return res.status(404).send('Order not found');
  if (row.approveToken !== token) return res.status(403).send('Invalid token');

  // Optionally, verify on-chain automatically before approving, or let the owner review tx
  // Here is a sample ETH check (asynchronously) — see verifyEthereumTx below
  // For demo, we mark approved and generate user verification code
  const verifyCode = (Math.floor(100000 + Math.random() * 900000)).toString(); // 6-digit code
  db.prepare('UPDATE orders SET status=?, verifyCode=?, verifiedAt=NULL WHERE id=?').run('approved', verifyCode, orderId);

  // send verification to user
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  await sendUserVerificationEmail(order);

  res.send(`<p>Order ${orderId} approved. Verification email sent to ${order.email}.</p>`);
});

// User verify endpoint (user clicks link in their email)
app.get('/verify', async (req, res) => {
  const { orderId, code } = req.query;
  if (!orderId || !code) return res.status(400).send('Missing params');
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!row) return res.status(404).send('Order not found');
  if (row.verifyCode !== code) return res.status(403).send('Invalid code');
  // mark verified and optionally create downloadable package and return link
  const verifiedAt = Date.now();
  db.prepare('UPDATE orders SET status=?, verifiedAt=? WHERE id=?').run('completed', verifiedAt, orderId);

  // TODO: generate download link (signed S3 URL or direct file)
  // For demo we send a simple message and you can implement generateDownloadLink(orderId)
  const downloadLink = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/download/${orderId}`;
  res.send(`<p>Verified! Download: <a href="${downloadLink}">Download your site package</a></p>`);
});

/* ==========================
   Optional: auto-verify ETH tx function
   ==========================
   You can call this to check that the provided tx hash indeed transfers ETH to your ETH_ADDRESS.
   For a real service you'd check value >= expected price (converted to ETH) and confirmations.
*/
async function verifyEthereumTx(txHash, expectedToAddressLower) {
  // Use public provider or your own node
  const provider = new ethers.providers.InfuraProvider(process.env.ETH_NETWORK || 'homestead', process.env.INFURA_API_KEY);
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { ok: false, message: 'tx not found' };
    // Check recipient
    if (!tx.to || tx.to.toLowerCase() !== expectedToAddressLower) return { ok: false, message: 'recipient mismatch' };
    // You may also check value (tx.value is BigNumber in wei)
    // Example: require tx.value.gte(ethers.utils.parseEther('0.01'))
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.confirmations < 3) return { ok: false, message: 'not enough confirmations' };
    return { ok: true, tx, receipt };
  } catch (err) {
    console.error('verifyEthereumTx error', err);
    return { ok: false, message: 'error' };
  }
}

// Admin route to run auto-check for ETH (optional; you could call this from /admin/approve)
app.get('/admin/check-eth', async (req, res) => {
  const { orderId } = req.query;
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!row) return res.status(404).send('Order not found');
  if (row.coin !== 'ETH') return res.status(400).send('Not ETH order');
  const result = await verifyEthereumTx(row.tx, ETH_ADDRESS);
  res.json(result);
});

// Placeholder download handler (in production serve S3 presigned or static package)
app.get('/download/:orderId', (req, res) => {
  const orderId = req.params.orderId;
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!row || row.status !== 'completed') return res.status(403).send('Not authorized or not completed');
  // TODO: replace with actual file serving or redirect to S3 presigned URL
  res.send(`<p>Here you'd send the ZIP for order ${orderId}. Implement S3 signed URL and redirect here.</p>`);
});

app.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));
