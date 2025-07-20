// integrations/Core.js
async function SendEmail({ to, from_name, subject, body }) {
  console.log(`📧 Sending email to ${to} - subject: ${subject}`);
  // כאן תוכל לשלב שירות אמיתי כמו Nodemailer, Mailgun וכו'
}

module.exports = { SendEmail };
