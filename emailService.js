const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MY_GMAIL,
    pass: process.env.GMAIL_APP_PASSWORD, // לא הסיסמה הרגילה שלך
  },
});

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"RiskWise" <${process.env.MY_GMAIL}>`,
      to,
      subject,
      html,
    });
    console.log(`📨 מייל נשלח אל ${to}`);
  } catch (err) {
    console.error('❌ שגיאה בשליחת מייל:', err.message);
  }
}

module.exports = { sendEmail };
