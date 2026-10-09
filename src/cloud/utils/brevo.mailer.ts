import { Logger } from '@nestjs/common';

type BrevoEmailPayload = {
  to: string | string[];
  toName?: string;
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromEmail?: string;
};

type BrevoConfig = {
  apiKey: string;
  from: string;
  fromName: string;
};

const logger = new Logger('BrevoMailer');

function getBrevoConfig(): BrevoConfig {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('BREVO_API_KEY belum dikonfigurasi');
  }

  const from =
    process.env.BREVO_FROM_EMAIL?.trim() ||
    process.env.SMTP_FROM_EMAIL?.trim();
  if (!from) {
    throw new Error('BREVO_FROM_EMAIL belum dikonfigurasi');
  }

  const fromName =
    process.env.BREVO_FROM_NAME?.trim() ||
    process.env.SMTP_FROM_NAME?.trim() ||
    process.env.CLOUD_BREVO_FROM_NAME?.trim() ||
    'Cloud Storage AMS';

  return { apiKey, from, fromName };
}

export async function sendBrevoEmail(payload: BrevoEmailPayload): Promise<void> {
  const config = getBrevoConfig();

  const emails = (Array.isArray(payload.to) ? payload.to : [payload.to])
    .map((e) => e?.trim())
    .filter((e): e is string => Boolean(e));
  if (!emails.length) {
    throw new Error('Brevo: penerima email kosong');
  }

  const to =
    emails.length === 1 && payload.toName
      ? [{ email: emails[0], name: payload.toName }]
      : emails.map((email) => ({ email }));

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': config.apiKey,
    },
    body: JSON.stringify({
      sender: {
        name: payload.fromName?.trim() || config.fromName,
        email: payload.fromEmail?.trim() || config.from,
      },
      to,
      subject: payload.subject,
      htmlContent: payload.html,
      textContent: payload.text,
    }),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = JSON.stringify(body);
    } catch {
      // ignore
    }
    logger.error(`Brevo send failed: ${detail}`);
    throw new Error(`Gagal mengirim email via Brevo: ${detail}`);
  }
}

export async function sendCloudResetPasswordEmail(
  to: string,
  token: string,
  otp: string,
  toName?: string,
  from?: string,
): Promise<void> {
  const base =
    process.env.CLOUD_FRONTEND_URL?.replace(/\/$/, '') || 'https://cloud.amscorp.id';
  const qs = new URLSearchParams({ verifylink: token });
  if (from === 'workspace') qs.set('from', 'workspace');
  const resetUrl = `${base}/forgot-password?${qs.toString()}`;

  const html = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
    <div style="background-color: #0ea5e9; padding: 20px; color: white;">
      <h2 style="margin: 0;">Cloud Storage — Reset Password</h2>
    </div>
    <div style="padding: 20px;">
      <p>Kami menerima permintaan reset password akun Cloud Storage Anda. Gunakan OTP di bawah atau klik tombol untuk melanjutkan:</p>
      <div style="background-color: #f4f4f4; padding: 16px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 2px; border-radius: 6px; margin: 16px 0;">
        ${otp}
      </div>
      <div style="text-align: center; margin: 24px 0;">
        <a href="${resetUrl}" style="background-color: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Reset Password
        </a>
      </div>
      <p>OTP dan link berlaku <strong>15 menit</strong>.</p>
    </div>
    <div style="background-color: #f9f9f9; padding: 16px; font-size: 12px; color: #777; text-align: center;">
      &copy; ${new Date().getFullYear()} Cloud Storage AMS. All rights reserved.
    </div>
  </div>`;

  await sendBrevoEmail({
    to,
    toName,
    subject: 'Reset Password — Cloud Storage AMS',
    html,
    text: `OTP Cloud Storage: ${otp}. Atau buka: ${resetUrl}`,
    fromName:
      process.env.CLOUD_BREVO_FROM_NAME?.trim() ||
      process.env.BREVO_FROM_NAME?.trim() ||
      'Cloud Storage AMS',
  });
}
